//! Ledger dispatch is asynchronous. Session and terminal events follow the
//! transcript listeners on that same dispatch, not the synchronous terminal hook.

use std::rc::Rc;

use futures::FutureExt;
use garcon_ledger::{
    contracts::{LedgerRowData, RunOutcome},
    service::{TranscriptCommitEvent, TranscriptCommitWork, TranscriptLedgerService},
};

use crate::{
    command_ledger::CommandLedger,
    event_bus::{AgentEventBus, AgentRunCompletionOutcome, CommittedRunOutcome},
    listener_dispatch::{ListenerWork, dispatch_listeners_sequentially},
};

use super::AgentRegistry;

pub type RegistryTranscriptListener = dyn for<'a> Fn(&'a TranscriptCommitEvent) -> ListenerWork<'a>;

impl AgentRegistry {
    pub fn events(&self) -> &AgentEventBus {
        &self.events
    }

    pub fn on_transcript_committed(&self, listener: Rc<RegistryTranscriptListener>) {
        let mut listeners = self.transcript_listeners.borrow_mut();
        if !listeners
            .iter()
            .any(|current| Rc::ptr_eq(current, &listener))
        {
            listeners.push(listener);
        }
    }

    pub fn bind_transcript_commits(
        self: &Rc<Self>,
        ledger: &TranscriptLedgerService,
        command_ledger: Rc<CommandLedger>,
    ) -> Box<dyn Fn()> {
        let owner = Rc::downgrade(self);
        ledger.subscribe(Rc::new(move |event| {
            let Some(registry) = owner.upgrade() else {
                return TranscriptCommitWork::Complete(Ok(()));
            };
            let mut fanout = Box::pin({
                let (registry, event) = (registry.clone(), event.clone());
                async move { registry.dispatch_transcript_listeners(&event).await }
            });
            // JS invokes the synchronous prefix during the subscriber call,
            // but awaits fanout before publishing to the bus, even if all listeners are synchronous.
            let fanout_complete = fanout.as_mut().now_or_never().is_some();
            let command_ledger = command_ledger.clone();
            TranscriptCommitWork::Pending(Box::pin(async move {
                if !fanout_complete {
                    fanout.await;
                }
                match event.as_ref() {
                    TranscriptCommitEvent::Session { chat_id, .. } => {
                        registry.events.publish_session(chat_id).await;
                    }
                    TranscriptCommitEvent::RunEnded {
                        chat_id,
                        run_id,
                        final_response,
                        working_directory,
                        row,
                        ..
                    } => {
                        if let Err(error) = command_ledger
                            .set_turn_result(chat_id, run_id, final_response.as_ref())
                            .await
                        {
                            registry.logger.error(&format!(
                                "Transcript listener failed ({chat_id}, run-ended): {error}"
                            ));
                        }
                        let LedgerRowData::RunEnded { outcome, error, .. } = &row.data else {
                            return Err(
                                "Run-ended notification does not contain a terminal row".into()
                            );
                        };
                        let outcome = match outcome {
                            RunOutcome::Finished => {
                                CommittedRunOutcome::Completed(AgentRunCompletionOutcome::Finished)
                            }
                            RunOutcome::Interrupted => CommittedRunOutcome::Completed(
                                AgentRunCompletionOutcome::Interrupted,
                            ),
                            RunOutcome::Failed => CommittedRunOutcome::Failed(error.clone()),
                        };
                        registry
                            .events
                            .publish_run_ended(chat_id, run_id, outcome, working_directory.clone())
                            .await;
                    }
                    _ => {}
                }
                Ok(())
            }))
        }))
    }

    async fn dispatch_transcript_listeners(&self, event: &TranscriptCommitEvent) {
        let chat_id = match event {
            TranscriptCommitEvent::Rows { chat_id, .. }
            | TranscriptCommitEvent::Session { chat_id, .. }
            | TranscriptCommitEvent::Permission { chat_id, .. }
            | TranscriptCommitEvent::RunEnded { chat_id, .. }
            | TranscriptCommitEvent::ViewReplaced { chat_id, .. } => chat_id,
        };
        let mut index = 0;
        let listeners = std::iter::from_fn(|| {
            let listener = self.transcript_listeners.borrow().get(index).cloned()?;
            index += 1;
            Some(listener)
        });
        dispatch_listeners_sequentially(
            listeners,
            |listener| listener(event),
            |error| {
                self.logger
                    .error(&format!("Transcript listener failed ({chat_id}): {error}"));
            },
        )
        .await;
    }
}
