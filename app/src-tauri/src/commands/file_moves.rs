//! Moving files between folders in batches Telegram accepts.
//!
//! A move copies messages into the target folder and then deletes the
//! originals. Telegram forwards and deletes at most 100 messages per request,
//! so a larger selection is moved batch by batch. Each batch is copied and
//! verified before its originals are deleted; a failed batch keeps its
//! originals and stops the move, so no file is ever lost.
use std::future::Future;

/// The most messages Telegram forwards or deletes in one request.
pub const MOVE_BATCH: usize = 100;

/// Where moved files go: Telegram in the application; a recording stand-in in
/// native journeys, so batching and partial failure can be exercised.
pub trait MessageMover: Sync {
    /// New message identifiers in the target folder, in order; `None` for a
    /// message Telegram did not copy.
    fn forward(&self, ids: &[i32])
        -> impl Future<Output = Result<Vec<Option<i32>>, String>> + Send;
    fn delete(&self, ids: &[i32]) -> impl Future<Output = Result<(), String>> + Send;
}

pub struct TelegramMover<'a> {
    pub client: &'a grammers_client::Client,
    pub source: &'a grammers_client::types::Peer,
    pub target: &'a grammers_client::types::Peer,
}

impl MessageMover for TelegramMover<'_> {
    async fn forward(&self, ids: &[i32]) -> Result<Vec<Option<i32>>, String> {
        let forwarded = self
            .client
            .forward_messages(self.target, ids, self.source)
            .await
            .map_err(|error| format!("Forward failed: {error}"))?;
        Ok(forwarded
            .iter()
            .map(|message| message.as_ref().map(|message| message.id()))
            .collect())
    }

    async fn delete(&self, ids: &[i32]) -> Result<(), String> {
        self.client
            .delete_messages(self.source, ids)
            .await
            .map(|_| ())
            .map_err(|error| format!("Delete original failed: {error}"))
    }
}

/// What a move achieved. `moved` pairs each original with its copy and holds
/// only files whose originals were deleted. `error` explains why the rest
/// stayed where they were.
#[derive(Debug, Default)]
pub struct MoveOutcome {
    pub moved: Vec<(i32, i32)>,
    pub error: Option<String>,
}

/// Move `ids` in batches. `may_delete` is checked after each copy and before
/// its originals are deleted, so an account change never deletes through
/// another session.
pub async fn move_in_batches<M: MessageMover>(
    mover: &M,
    ids: &[i32],
    may_delete: impl Fn() -> Result<(), String>,
) -> MoveOutcome {
    let mut outcome = MoveOutcome::default();
    for batch in ids.chunks(MOVE_BATCH) {
        let copies = match mover.forward(batch).await {
            Ok(copies) => copies,
            Err(error) => {
                outcome.error = Some(error);
                break;
            }
        };
        if copies.len() != batch.len() || copies.iter().any(Option::is_none) {
            outcome.error = Some("Some files were not copied; the originals were kept".into());
            break;
        }
        if let Err(error) = may_delete() {
            outcome.error = Some(error);
            break;
        }
        if let Err(error) = mover.delete(batch).await {
            outcome.error = Some(error);
            break;
        }
        outcome
            .moved
            .extend(batch.iter().copied().zip(copies.into_iter().flatten()));
    }
    if let Some(error) = outcome.error.take() {
        outcome.error = Some(if outcome.moved.is_empty() {
            error
        } else {
            format!(
                "Moved {} of {} files; the rest were kept: {error}",
                outcome.moved.len(),
                ids.len()
            )
        });
    }
    outcome
}
