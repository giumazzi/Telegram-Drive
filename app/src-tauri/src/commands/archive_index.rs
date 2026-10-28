//! What an archive on Telegram contains, read without downloading it.
//!
//! 7z and ZIP archives keep an index of their entries, near the end of the
//! archive. A split archive (`name.7z.001`, `.002`…) is one archive cut into
//! byte slices, so its parts are read as one continuous stream. Only the
//! 64 KiB blocks the archive library asks for are fetched, within a fixed
//! budget per archive; entry contents are never read. Password-protected
//! indexes, RAR volumes and damaged archives are reported as unreadable.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

/// Telegram serves file data in aligned blocks; this size keeps every block
/// inside one of its 1 MiB windows.
pub const RANGE_BLOCK: u64 = 65_536;
/// Bytes one archive may fetch. An index larger than this is not worth it.
pub const MAX_INDEX_FETCH: u64 = 16 * 1024 * 1024;
/// Entries reported per archive; classification needs only the largest.
pub const MAX_REPORTED_ENTRIES: usize = 500;
pub const MAX_ARCHIVES_PER_CALL: usize = 500;

/// Where archive bytes come from: Telegram in the application; files on disk
/// in native journeys. Blocking, because the archive libraries read blocking.
pub trait RangeSource {
    /// Block `index` (offset `index * RANGE_BLOCK`) of part `part`; shorter at
    /// the end of the part.
    fn block(&self, part: usize, index: u64) -> Result<Vec<u8>, String>;
}

/// The parts of one archive as a single seekable stream.
pub struct RangeReader<'a, S: RangeSource> {
    source: &'a S,
    part_sizes: Vec<u64>,
    total: u64,
    position: u64,
    blocks: HashMap<(usize, u64), Vec<u8>>,
    fetched: u64,
}

impl<'a, S: RangeSource> RangeReader<'a, S> {
    pub fn new(source: &'a S, part_sizes: Vec<u64>) -> Self {
        let total = part_sizes.iter().sum();
        Self {
            source,
            part_sizes,
            total,
            position: 0,
            blocks: HashMap::new(),
            fetched: 0,
        }
    }

    pub fn total_len(&self) -> u64 {
        self.total
    }

    /// Bytes fetched from the source so far.
    pub fn fetched(&self) -> u64 {
        self.fetched
    }

    fn locate(&self, position: u64) -> Option<(usize, u64)> {
        let mut start = 0;
        for (part, size) in self.part_sizes.iter().enumerate() {
            if position < start + size {
                return Some((part, position - start));
            }
            start += size;
        }
        None
    }
}

impl<S: RangeSource> Read for RangeReader<'_, S> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let Some((part, offset)) = self.locate(self.position) else {
            return Ok(0);
        };
        let index = offset / RANGE_BLOCK;
        if !self.blocks.contains_key(&(part, index)) {
            if self.fetched >= MAX_INDEX_FETCH {
                return Err(std::io::Error::other("ARCHIVE_INDEX_TOO_LARGE"));
            }
            let block = self
                .source
                .block(part, index)
                .map_err(std::io::Error::other)?;
            let expected = (self.part_sizes[part] - index * RANGE_BLOCK).min(RANGE_BLOCK);
            if block.len() as u64 != expected {
                return Err(std::io::Error::other("The archive part ended unexpectedly"));
            }
            self.fetched += block.len() as u64;
            self.blocks.insert((part, index), block);
        }
        let block = &self.blocks[&(part, index)];
        let start = (offset - index * RANGE_BLOCK) as usize;
        let count = buffer.len().min(block.len() - start);
        buffer[..count].copy_from_slice(&block[start..start + count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl<S: RangeSource> Seek for RangeReader<'_, S> {
    fn seek(&mut self, target: SeekFrom) -> std::io::Result<u64> {
        let position = match target {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(offset) => self.total.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        }
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid seek"))?;
        self.position = position;
        Ok(position)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    SevenZ,
    Zip,
}

impl ArchiveKind {
    /// From the whole archive's name; split parts are named by the caller.
    pub fn of(name: &str) -> Option<Self> {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".7z") {
            Some(Self::SevenZ)
        } else if lower.ends_with(".zip") {
            Some(Self::Zip)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveItem {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveContents {
    pub key: String,
    pub readable: bool,
    /// The largest entries first, at most [`MAX_REPORTED_ENTRIES`].
    pub entries: Vec<ArchiveItem>,
    pub total_entries: usize,
}

/// List an archive's files (not folders) through `source`.
pub fn list_archive<S: RangeSource>(
    source: &S,
    part_sizes: Vec<u64>,
    kind: ArchiveKind,
) -> Result<(Vec<ArchiveItem>, u64), String> {
    let mut reader = RangeReader::new(source, part_sizes);
    let mut items = match kind {
        ArchiveKind::SevenZ => {
            let length = reader.total_len();
            let archive = sevenz_rust2::Archive::read(&mut reader, length, &[])
                .map_err(|error| format!("The 7z index could not be read: {error}"))?;
            archive
                .files
                .iter()
                .filter(|entry| !entry.is_directory())
                .map(|entry| ArchiveItem {
                    name: entry.name().to_string(),
                    size: entry.size(),
                })
                .collect::<Vec<_>>()
        }
        ArchiveKind::Zip => {
            let mut archive = zip::ZipArchive::new(&mut reader)
                .map_err(|error| format!("The ZIP index could not be read: {error}"))?;
            let mut items = Vec::with_capacity(archive.len());
            for index in 0..archive.len() {
                let entry = archive
                    .by_index_raw(index)
                    .map_err(|error| format!("The ZIP index could not be read: {error}"))?;
                if !entry.is_dir() {
                    items.push(ArchiveItem {
                        name: entry.name().to_string(),
                        size: entry.size(),
                    });
                }
            }
            items
        }
    };
    items.sort_by_key(|item| std::cmp::Reverse(item.size));
    Ok((items, reader.fetched()))
}

/// Describe one archive, never failing the whole request for it.
pub fn describe_archive<S: RangeSource>(
    key: String,
    source: &S,
    part_sizes: Vec<u64>,
    kind: Option<ArchiveKind>,
) -> ArchiveContents {
    let listed = kind
        .ok_or_else(|| "Unsupported archive".to_string())
        .and_then(|kind| list_archive(source, part_sizes, kind));
    match listed {
        Ok((mut entries, _)) => {
            let total_entries = entries.len();
            entries.truncate(MAX_REPORTED_ENTRIES);
            ArchiveContents {
                key,
                readable: true,
                entries,
                total_entries,
            }
        }
        Err(error) => {
            log::info!("Archive index unavailable: {error}");
            ArchiveContents {
                key,
                ..ArchiveContents::default()
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequest {
    pub key: String,
    /// The whole archive's name, such as `film.7z` for `film.7z.001`.
    pub name: String,
    /// Message ids of its parts, in order; one id for an unsplit archive.
    pub message_ids: Vec<i32>,
}

struct TelegramRanges {
    client: grammers_client::Client,
    media: Vec<grammers_client::types::Media>,
    runtime: tokio::runtime::Handle,
    account: crate::workspace::AccountGuard,
}

impl RangeSource for TelegramRanges {
    fn block(&self, part: usize, index: u64) -> Result<Vec<u8>, String> {
        self.account.validate()?;
        let media = self.media.get(part).ok_or("Unknown archive part")?;
        let skip = i32::try_from(index).map_err(|_| "Archive part is too large")?;
        self.runtime
            .block_on(async {
                self.client
                    .iter_download(media)
                    .chunk_size(RANGE_BLOCK as i32)
                    .skip_chunks(skip)
                    .next()
                    .await
            })
            .map_err(crate::commands::utils::map_error)
            .map(Option::unwrap_or_default)
    }
}

#[tauri::command]
pub async fn cmd_inspect_archives(
    app: tauri::AppHandle,
    owner_id: Option<String>,
    folder_id: Option<i64>,
    archives: Vec<ArchiveRequest>,
    state: tauri::State<'_, crate::TelegramState>,
) -> Result<Vec<ArchiveContents>, String> {
    use tauri::Manager;
    if archives.len() > MAX_ARCHIVES_PER_CALL {
        return Err(format!(
            "Ask for at most {MAX_ARCHIVES_PER_CALL} archives at once"
        ));
    }
    let account = crate::workspace::AccountGuard::open(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        owner_id.as_deref(),
    )?;
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Client not connected".to_string())?;
    account.validate_client(&client).await?;
    let peer = crate::commands::utils::resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let mut results = Vec::with_capacity(archives.len());
    for request in archives {
        account.validate()?;
        let unreadable = ArchiveContents {
            key: request.key.clone(),
            ..ArchiveContents::default()
        };
        if request.message_ids.is_empty() || request.message_ids.len() > 999 {
            results.push(unreadable);
            continue;
        }
        let messages = client
            .get_messages_by_id(&peer, &request.message_ids)
            .await
            .map_err(crate::commands::utils::map_error)?;
        let media: Option<Vec<_>> = messages
            .into_iter()
            .map(|message| message.and_then(|message| message.media()))
            .collect();
        let Some(media) = media else {
            results.push(unreadable);
            continue;
        };
        let part_sizes = media
            .iter()
            .map(crate::commands::utils::media_size)
            .collect();
        let source = TelegramRanges {
            client: client.clone(),
            media,
            runtime: tokio::runtime::Handle::current(),
            account: account.clone(),
        };
        let kind = ArchiveKind::of(&request.name);
        let key = request.key;
        let contents =
            tokio::task::spawn_blocking(move || describe_archive(key, &source, part_sizes, kind))
                .await
                .map_err(|error| format!("Archive inspection failed: {error}"))?;
        results.push(contents);
    }
    account.validate()?;
    Ok(results)
}
