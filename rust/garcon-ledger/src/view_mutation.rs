use std::{rc::Rc, task::Poll};

use futures::future::LocalBoxFuture;
use garcon_base::{errors::ErrorInput, unhandled_rejection_policy::UnhandledRejectionPolicy};
use tokio::sync::oneshot;

use crate::sqlite_operations::LedgerResult;

pub type ReleaseTranscriptSnapshot = Box<dyn FnOnce() -> LocalBoxFuture<'static, LedgerResult<()>>>;
pub type ReopenProducer = dyn Fn(&str) -> LedgerResult<()>;

pub trait TranscriptMutationExecution {
    /// The returned operation releases this exact reservation.
    fn reserve_transcript_snapshot(&self, chat_id: &str)
    -> LedgerResult<ReleaseTranscriptSnapshot>;
    fn has_pending_turn_input<'a>(
        &'a self,
        chat_id: &'a str,
    ) -> LocalBoxFuture<'a, LedgerResult<bool>>;
}

pub(crate) async fn settle_owned_mutation<T: 'static>(
    mut work: LocalBoxFuture<'static, LedgerResult<T>>,
    errors: Rc<UnhandledRejectionPolicy>,
) -> LedgerResult<T> {
    // Claim the mutation lock in caller order; a dropped waiter cannot cancel owned work.
    if let Poll::Ready(result) = futures::poll!(&mut work) {
        return result;
    }
    let (done, result) = oneshot::channel();
    tokio::task::spawn_local(async move {
        if let Err(Err(error)) = done.send(work.await) {
            errors.report(ErrorInput::Error(error.as_ref()));
        }
    });
    result.await?
}
