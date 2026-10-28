//! Where a file came from, so it can be recognised before it is organised.
//!
//! The file list shows a message's caption as its name, and every photo as
//! "Photo.jpg". For a file forwarded from a channel the useful facts are the
//! document's own name, the caption, when it was first posted and by whom.
//! Protected (TDENC2) files are never described: their captions and names may
//! carry envelope data, and their real metadata stays inside the envelope.
use grammers_session::types::{PeerKind, PeerRef};
use grammers_tl_types as tl;
use serde::Serialize;
use tauri::{Manager, State};

/// Telegram returns at most this many messages per request.
pub const ORIGIN_BATCH: usize = 100;
/// Bounds one lookup; the organiser asks for a folder's files in pages.
pub const MAX_ORIGIN_IDS: usize = 5_000;
const MAX_CAPTION_CHARS: usize = 300;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileOrigin {
    pub id: i32,
    /// The document's own filename, or "Performer – Title" for audio.
    pub original_name: Option<String>,
    pub caption: Option<String>,
    /// When the forwarded message was first posted (RFC 3339).
    pub original_date: Option<String>,
    /// The channel, group or person it was forwarded from.
    pub source: Option<String>,
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn document_attributes(media: &tl::enums::MessageMedia) -> Option<&[tl::enums::DocumentAttribute]> {
    let tl::enums::MessageMedia::Document(media) = media else {
        return None;
    };
    match media.document.as_ref()? {
        tl::enums::Document::Document(document) => Some(&document.attributes),
        tl::enums::Document::Empty(_) => None,
    }
}

fn original_name(attributes: &[tl::enums::DocumentAttribute]) -> Option<String> {
    let audio = attributes.iter().find_map(|attribute| match attribute {
        tl::enums::DocumentAttribute::Audio(audio) => {
            let title = audio.title.as_deref().and_then(non_empty)?;
            Some(match audio.performer.as_deref().and_then(non_empty) {
                Some(performer) => format!("{performer} – {title}"),
                None => title,
            })
        }
        _ => None,
    });
    audio.or_else(|| {
        attributes.iter().find_map(|attribute| match attribute {
            tl::enums::DocumentAttribute::Filename(file) => non_empty(&file.file_name),
            _ => None,
        })
    })
}

fn is_protected(attributes: Option<&[tl::enums::DocumentAttribute]>, caption: &str) -> bool {
    let name = attributes.and_then(original_name).unwrap_or_default();
    caption.trim() == "TDENC2" || name == "TDENC2" || name.to_ascii_lowercase().ends_with(".tdenc")
}

fn peer_name(
    peer: &tl::enums::Peer,
    chats: &[tl::enums::Chat],
    users: &[tl::enums::User],
) -> Option<String> {
    let chat_title = |id: i64| {
        chats.iter().find_map(|chat| match chat {
            tl::enums::Chat::Channel(channel) if channel.id == id => non_empty(&channel.title),
            tl::enums::Chat::Chat(group) if group.id == id => non_empty(&group.title),
            tl::enums::Chat::ChannelForbidden(channel) if channel.id == id => {
                non_empty(&channel.title)
            }
            tl::enums::Chat::Forbidden(group) if group.id == id => non_empty(&group.title),
            _ => None,
        })
    };
    match peer {
        tl::enums::Peer::Channel(channel) => chat_title(channel.channel_id),
        tl::enums::Peer::Chat(group) => chat_title(group.chat_id),
        tl::enums::Peer::User(user) => users.iter().find_map(|candidate| match candidate {
            tl::enums::User::User(person) if person.id == user.user_id => {
                let name = [person.first_name.as_deref(), person.last_name.as_deref()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ");
                non_empty(&name).or_else(|| person.username.as_deref().and_then(non_empty))
            }
            _ => None,
        }),
    }
}

fn timestamp(seconds: i32) -> Option<String> {
    chrono::DateTime::from_timestamp(i64::from(seconds), 0).map(|date| date.to_rfc3339())
}

/// Describe the requested messages from one `getMessages` response. Messages
/// that are missing, not files, or protected are described by their id only.
pub fn origins_from_messages(
    requested: &[i32],
    messages: &[tl::enums::Message],
    chats: &[tl::enums::Chat],
    users: &[tl::enums::User],
) -> Vec<FileOrigin> {
    requested
        .iter()
        .map(|id| {
            let message = messages.iter().find_map(|message| match message {
                tl::enums::Message::Message(message) if message.id == *id => Some(message),
                _ => None,
            });
            let Some(message) = message.filter(|message| message.media.is_some()) else {
                return FileOrigin {
                    id: *id,
                    ..FileOrigin::default()
                };
            };
            let attributes = message.media.as_ref().and_then(document_attributes);
            if is_protected(attributes, &message.message) {
                return FileOrigin {
                    id: *id,
                    ..FileOrigin::default()
                };
            }
            let forward = message.fwd_from.as_ref().map(|header| match header {
                tl::enums::MessageFwdHeader::Header(header) => header,
            });
            FileOrigin {
                id: *id,
                original_name: attributes.and_then(original_name),
                caption: non_empty(&message.message)
                    .map(|caption| caption.chars().take(MAX_CAPTION_CHARS).collect()),
                original_date: forward.and_then(|header| timestamp(header.date)),
                source: forward.and_then(|header| {
                    header
                        .from_id
                        .as_ref()
                        .and_then(|peer| peer_name(peer, chats, users))
                        .or_else(|| header.from_name.as_deref().and_then(non_empty))
                }),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn cmd_get_file_origins(
    app: tauri::AppHandle,
    owner_id: Option<String>,
    folder_id: Option<i64>,
    message_ids: Vec<i32>,
    state: State<'_, crate::TelegramState>,
) -> Result<Vec<FileOrigin>, String> {
    if message_ids.len() > MAX_ORIGIN_IDS {
        return Err(format!("Ask for at most {MAX_ORIGIN_IDS} files at once"));
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
    let peer: PeerRef = (&peer).into();
    let mut origins = Vec::with_capacity(message_ids.len());
    for batch in message_ids.chunks(ORIGIN_BATCH) {
        account.validate()?;
        let id = batch
            .iter()
            .map(|&id| tl::enums::InputMessage::Id(tl::types::InputMessageId { id }))
            .collect();
        let response = if peer.id.kind() == PeerKind::Channel {
            client
                .invoke(&tl::functions::channels::GetMessages {
                    channel: peer.into(),
                    id,
                })
                .await
        } else {
            client
                .invoke(&tl::functions::messages::GetMessages { id })
                .await
        }
        .map_err(crate::commands::utils::map_error)?;
        let (messages, users, chats) = match response {
            tl::enums::messages::Messages::Messages(m) => (m.messages, m.users, m.chats),
            tl::enums::messages::Messages::Slice(m) => (m.messages, m.users, m.chats),
            tl::enums::messages::Messages::ChannelMessages(m) => (m.messages, m.users, m.chats),
            tl::enums::messages::Messages::NotModified(_) => (Vec::new(), Vec::new(), Vec::new()),
        };
        origins.extend(origins_from_messages(batch, &messages, &chats, &users));
    }
    account.validate()?;
    Ok(origins)
}
