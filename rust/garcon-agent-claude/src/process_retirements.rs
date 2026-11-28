use std::{cell::RefCell, rc::Rc};

use garcon_interface::resources::ExecutorResult;
use indexmap::IndexMap;

use crate::cli_process_transport::ClaudeExitStatus;

struct ProcessRetirementGroup {
    chat_id: String,
    process_exits: Vec<Rc<ClaudeExitStatus>>,
}

#[derive(Default)]
pub struct ClaudeProcessRetirementTracker {
    process_exits: Rc<RefCell<IndexMap<String, ProcessRetirementGroup>>>,
}

impl ClaudeProcessRetirementTracker {
    pub fn track(
        &self,
        agent_session_id: &str,
        chat_id: &str,
        process_exit: Rc<ClaudeExitStatus>,
    ) -> ExecutorResult<()> {
        {
            let mut exits = self.process_exits.borrow_mut();
            let group = exits.entry(agent_session_id.to_owned()).or_insert_with(|| {
                ProcessRetirementGroup {
                    chat_id: chat_id.to_owned(),
                    process_exits: Vec::new(),
                }
            });
            if group.chat_id != chat_id {
                return Err("Chat ID mismatch".into());
            }
            if group
                .process_exits
                .iter()
                .any(|prior| Rc::ptr_eq(prior, &process_exit))
            {
                return Ok(());
            }
            group.process_exits.push(process_exit.clone());
        }
        let exits = Rc::downgrade(&self.process_exits);
        let agent_session_id = agent_session_id.to_owned();
        tokio::task::spawn_local(async move {
            // An unobservable exit remains a fence against concurrent writers.
            if process_exit.as_ref().clone().await.is_err() {
                return;
            }
            let Some(exits) = exits.upgrade() else {
                return;
            };
            let mut exits = exits.borrow_mut();
            if let Some(group) = exits.get_mut(&agent_session_id) {
                group
                    .process_exits
                    .retain(|prior| !Rc::ptr_eq(prior, &process_exit));
                if group.process_exits.is_empty() {
                    exits.shift_remove(&agent_session_id);
                }
            }
        });
        Ok(())
    }

    pub async fn wait(&self, agent_session_id: &str, chat_id: &str) -> ExecutorResult<()> {
        let process_exits = {
            let exits = self.process_exits.borrow();
            let Some(group) = exits.get(agent_session_id) else {
                return Ok(());
            };
            if group.chat_id != chat_id {
                return Err("Chat ID mismatch".into());
            }
            group
                .process_exits
                .iter()
                .map(|exit| exit.as_ref().clone())
                .collect::<Vec<_>>()
        };
        futures::future::try_join_all(process_exits).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use futures::future::{FutureExt, poll_fn};
    use tokio::{sync::oneshot, task::LocalSet};

    use super::*;

    #[tokio::test]
    async fn holds_admission_until_every_exit_and_keeps_failed_fences() {
        LocalSet::new()
            .run_until(async {
                let tracker = ClaudeProcessRetirementTracker::default();
                let (first, first_exit) = oneshot::channel();
                let (second, second_exit) = oneshot::channel();
                let first_exit = Rc::new(
                    async move { first_exit.await.unwrap() }
                        .boxed_local()
                        .shared(),
                );
                let second_exit = Rc::new(
                    async move { second_exit.await.unwrap() }
                        .boxed_local()
                        .shared(),
                );
                tracker
                    .track("session-1", "chat-1", first_exit.clone())
                    .unwrap();
                tracker
                    .track("session-1", "chat-1", second_exit.clone())
                    .unwrap();
                tracker.track("session-1", "chat-1", first_exit).unwrap();
                assert_eq!(
                    tracker
                        .track("session-1", "chat-2", second_exit)
                        .unwrap_err()
                        .to_string(),
                    "Chat ID mismatch"
                );
                let mut waiting = Box::pin(tracker.wait("session-1", "chat-1"));
                poll_fn(|cx| {
                    assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
                    std::task::Poll::Ready(())
                })
                .await;
                first.send(Ok(0)).unwrap();
                poll_fn(|cx| {
                    assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
                    std::task::Poll::Ready(())
                })
                .await;
                second.send(Err("synthetic lost exit".to_owned())).unwrap();
                assert_eq!(
                    waiting.await.unwrap_err().to_string(),
                    "synthetic lost exit"
                );
                assert_eq!(
                    tracker
                        .wait("session-1", "chat-1")
                        .await
                        .unwrap_err()
                        .to_string(),
                    "synthetic lost exit"
                );
            })
            .await;
    }
}
