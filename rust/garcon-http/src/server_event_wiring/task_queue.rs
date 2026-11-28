use std::{cell::RefCell, collections::HashMap, error::Error, future::Future, rc::Rc};

use futures::future::{FutureExt, LocalBoxFuture, Shared, join_all};
use garcon_base::{
    event_loop_stalls::ActivityTracker,
    log::{Logger, ScopedLogger, create_logger},
};
use tokio::sync::oneshot;

pub(super) type Completion = Shared<LocalBoxFuture<'static, ()>>;

#[derive(Default)]
struct Pending {
    next_id: u64,
    chat_tails: HashMap<String, u64>,
    active: HashMap<u64, Completion>,
    first_error: Option<Box<dyn Error>>,
}

pub(super) struct ChatTaskQueue {
    pending: RefCell<Pending>,
    activities: Rc<ActivityTracker>,
    logger: ScopedLogger,
}

impl ChatTaskQueue {
    pub(super) fn new(activities: Rc<ActivityTracker>) -> Rc<Self> {
        Rc::new(Self {
            pending: RefCell::default(),
            activities,
            logger: create_logger("server-events"),
        })
    }

    // Enqueue synchronously so commit fanout precedes terminal-driven lifecycle
    // events, even when none of their callers await task completion.
    pub(super) fn schedule(
        self: &Rc<Self>,
        chat_id: &str,
        activity: &'static str,
        task: impl Future<Output = Result<(), Box<dyn Error>>> + 'static,
    ) -> Completion {
        self.spawn(Some(chat_id.to_owned()), activity, task)
    }

    pub(super) fn track(
        self: &Rc<Self>,
        activity: &'static str,
        task: impl Future<Output = Result<(), Box<dyn Error>>> + 'static,
    ) -> Completion {
        self.spawn(None, activity, task)
    }

    fn spawn(
        self: &Rc<Self>,
        chat_id: Option<String>,
        activity: &'static str,
        task: impl Future<Output = Result<(), Box<dyn Error>>> + 'static,
    ) -> Completion {
        let (send, receive) = oneshot::channel();
        let completion = async move {
            let _ = receive.await;
        }
        .boxed_local()
        .shared();
        let mut pending = self.pending.borrow_mut();
        let id = pending.next_id;
        pending.next_id += 1;
        let previous = chat_id
            .as_ref()
            .and_then(|chat_id| pending.chat_tails.insert(chat_id.clone(), id))
            .and_then(|previous| pending.active.get(&previous).cloned());
        pending.active.insert(id, completion.clone());
        drop(pending);

        let queue = Rc::clone(self);
        tokio::task::spawn_local(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            let result = if chat_id.is_some() {
                queue
                    .activities
                    .with_activity(&format!("chat task {activity}"), task)
                    .await
            } else {
                task.await
            };
            if let Err(error) = result {
                queue
                    .logger
                    .warn(&format!("server-events: {activity} failed: {error}"));
                queue.pending.borrow_mut().first_error.get_or_insert(error);
            }
            let mut pending = queue.pending.borrow_mut();
            pending.active.remove(&id);
            if let Some(chat_id) = chat_id
                && pending.chat_tails.get(&chat_id) == Some(&id)
            {
                pending.chat_tails.remove(&chat_id);
            }
            drop(pending);
            let _ = send.send(());
        });
        completion
    }

    pub(super) async fn wait_for_idle(&self) -> Result<(), Box<dyn Error>> {
        loop {
            let active: Vec<_> = self.pending.borrow().active.values().cloned().collect();
            if active.is_empty() {
                return self
                    .pending
                    .borrow_mut()
                    .first_error
                    .take()
                    .map_or(Ok(()), Err);
            }
            join_all(active).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn commit_fanout_precedes_terminal_events_without_blocking_other_chats() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let queue = ChatTaskQueue::new(Rc::default());
                let events = Rc::new(RefCell::new(Vec::new()));
                let (release, hold) = oneshot::channel();
                let (began, entered) = oneshot::channel();
                let started = queue.schedule("chat", "transcript commit fanout", {
                    let events = events.clone();
                    async move {
                        began.send(()).unwrap();
                        hold.await?;
                        events.borrow_mut().push("chat-messages");
                        Ok(())
                    }
                });
                let stopped = queue.schedule("chat", "terminal lifecycle", {
                    let events = events.clone();
                    async move {
                        events.borrow_mut().push("chat-session-stopped");
                        events.borrow_mut().push("agent-run-finished");
                        Ok(())
                    }
                });
                drop(started);
                drop(stopped);
                entered.await.unwrap();
                queue
                    .schedule("other-chat", "transcript commit fanout", {
                        let events = events.clone();
                        async move {
                            events.borrow_mut().push("other-chat-messages");
                            Ok(())
                        }
                    })
                    .await;
                assert_eq!(*events.borrow(), ["other-chat-messages"]);
                release.send(()).unwrap();
                queue.wait_for_idle().await.unwrap();
                assert_eq!(
                    *events.borrow(),
                    [
                        "other-chat-messages",
                        "chat-messages",
                        "chat-session-stopped",
                        "agent-run-finished",
                    ]
                );
            })
            .await;
    }

    #[tokio::test]
    async fn idle_wait_includes_tasks_added_by_a_running_task_and_reports_first_failure_once() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let queue = ChatTaskQueue::new(Rc::default());
                drop(queue.track("chat activity recovery", {
                    let queue = queue.clone();
                    async move {
                        drop(queue.schedule("chat", "chat activity publication", async {
                            Err("failure from queued task".into())
                        }));
                        Err("failure from running task".into())
                    }
                }));
                assert_eq!(
                    queue.wait_for_idle().await.unwrap_err().to_string(),
                    "failure from running task"
                );
                queue.wait_for_idle().await.unwrap();
                assert!(queue.pending.borrow().chat_tails.is_empty());
            })
            .await;
    }
}
