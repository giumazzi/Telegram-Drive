//! Rejoining a file that was stored on Telegram as numbered parts.
//!
//! Each part downloads as an ordinary transfer, with its own retries and
//! collision handling. Once every part is saved, the parts are concatenated
//! in order into a private partial file beside the destination, which is then
//! published like any other download. The parts are removed only after the
//! whole file has been published. Only completed downloads of the signed-in
//! account can be joined, so this never reads or deletes arbitrary files.
use crate::commands::download_destination::{
    publish_download_file, DownloadCollisionPolicy, DownloadPublication,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Telegram Drive stores at most this many parts for one file.
pub const MAX_JOIN_PARTS: usize = 999;

fn same_directory(left: &Path, right: &Path) -> bool {
    match (left.parent(), right.parent()) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Join `parts`, in the given order, into `destination`.
///
/// `completed` holds the save paths of this account's completed downloads;
/// every part must be one of them and sit in the destination's directory.
/// `expected_bytes`, when known, is the size Telegram reported for all parts.
pub async fn join_split_parts(
    parts: Vec<PathBuf>,
    destination: PathBuf,
    policy: DownloadCollisionPolicy,
    expected_bytes: Option<u64>,
    completed: &HashSet<PathBuf>,
    account: Option<crate::workspace::AccountGuard>,
) -> Result<DownloadPublication, String> {
    if parts.len() < 2 || parts.len() > MAX_JOIN_PARTS {
        return Err(format!(
            "A split file has between 2 and {MAX_JOIN_PARTS} parts"
        ));
    }
    if parts.iter().collect::<HashSet<_>>().len() != parts.len() {
        return Err("A part was listed more than once".into());
    }
    for part in &parts {
        if !completed.contains(part) {
            return Err("Only completed downloads can be joined".into());
        }
        if !same_directory(part, &destination) || part == &destination {
            return Err("Parts must be saved beside the joined file".into());
        }
    }
    let partial = crate::commands::fs::download_partial_path(&destination)?;
    let check_account = account.clone();
    let staged = partial.clone();
    let sources = parts.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut output = crate::commands::fs::create_private_partial_file(&staged)?;
        let mut written = 0u64;
        let result = (|| {
            for part in &sources {
                if let Some(account) = check_account.as_ref() {
                    account.validate()?;
                }
                let mut input = std::fs::File::open(part)
                    .map_err(|error| format!("A downloaded part is unavailable: {error}"))?;
                written += std::io::copy(&mut input, &mut output)
                    .map_err(|error| format!("Could not join the parts: {error}"))?;
            }
            if expected_bytes.is_some_and(|expected| expected != written) {
                return Err(
                    "The joined file does not have the expected size; the parts were kept"
                        .to_string(),
                );
            }
            output
                .sync_all()
                .map_err(|error| format!("Could not save the joined file: {error}"))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&staged);
        }
        result
    })
    .await
    .map_err(|error| format!("Joining the parts failed: {error}"))??;

    let publication =
        match publish_download_file(partial.clone(), destination, policy, account).await {
            Ok(publication) => publication,
            Err(error) => {
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(error);
            }
        };
    // A skipped publication leaves the staged copy behind; it is never needed.
    let _ = tokio::fs::remove_file(&partial).await;
    for part in &parts {
        if let Err(error) = tokio::fs::remove_file(part).await {
            log::warn!("Joined file published but a part could not be removed: {error}");
        }
    }
    Ok(publication)
}

#[tauri::command]
pub async fn cmd_join_split_download(
    app: tauri::AppHandle,
    owner_id: String,
    part_paths: Vec<String>,
    destination: String,
    collision_policy: DownloadCollisionPolicy,
    expected_bytes: Option<u64>,
) -> Result<String, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri::Manager;
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let account = crate::workspace::AccountGuard::open(&root, Some(&owner_id))?;
        let engine = app
            .try_state::<std::sync::Arc<crate::transfer_engine::TransferEngine>>()
            .ok_or("The transfer queue is unavailable")?;
        let completed = engine
            .completed_downloads(&owner_id)
            .await?
            .into_iter()
            .filter_map(|job| job.save_path.map(PathBuf::from))
            .collect();
        join_split_parts(
            part_paths.into_iter().map(PathBuf::from).collect(),
            PathBuf::from(destination),
            collision_policy,
            expected_bytes,
            &completed,
            Some(account),
        )
        .await?
        .response()
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (
            app,
            owner_id,
            part_paths,
            destination,
            collision_policy,
            expected_bytes,
        );
        Err("Joining split files is available on desktop".into())
    }
}
