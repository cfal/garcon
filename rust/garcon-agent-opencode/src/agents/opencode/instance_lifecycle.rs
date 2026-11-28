//! Ports `server-agents/opencode/src/agents/opencode/instance-lifecycle.ts`.

use std::{cell::RefCell, rc::Rc};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared, join_all},
};
use garcon_interface::resources::ExecutorResult;
use indexmap::IndexMap;
use tokio::{sync::oneshot, task::spawn_local};

use super::{request_control::with_abortable_timeout, sdk_client::OpenCodeClient};
use crate::js::{AbortSignal, SharedError, error};

#[derive(Debug, Clone)]
pub enum OpenCodeServerTermination {
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
    Error(SharedError),
}

pub type OpenCodeTermination = Shared<LocalBoxFuture<'static, OpenCodeServerTermination>>;
type CloseInstance = Rc<dyn Fn() -> ExecutorResult<()>>;

pub struct OpenCodeServer {
    pub close: Option<CloseInstance>,
    pub termination: Option<OpenCodeTermination>,
    pub exit_observed: Option<Rc<dyn Fn() -> bool>>,
}

pub struct OpenCodeInstance {
    pub client: Rc<dyn OpenCodeClient>,
    pub base_url: Option<String>,
    pub server: Option<OpenCodeServer>,
    pub close: Option<CloseInstance>,
}

pub fn close_open_code_instance(instance: &OpenCodeInstance) {
    let close = instance
        .server
        .as_ref()
        .and_then(|server| server.close.as_ref())
        .or(instance.close.as_ref());
    if let Some(close) = close {
        let _ = close();
    }
}

type Pending = Shared<LocalBoxFuture<'static, ()>>;

#[derive(Default)]
struct TrackedCreations {
    next_id: u64,
    pending: IndexMap<u64, Pending>,
}

pub struct OpenCodeInstanceCreationTracker {
    is_shutting_down: Rc<dyn Fn() -> bool>,
    creations: Rc<RefCell<TrackedCreations>>,
}

impl OpenCodeInstanceCreationTracker {
    pub fn new(is_shutting_down: Rc<dyn Fn() -> bool>) -> Self {
        Self {
            is_shutting_down,
            creations: Rc::default(),
        }
    }

    pub fn track<F>(
        &self,
        create: impl FnOnce() -> F + 'static,
        signal: AbortSignal,
    ) -> LocalBoxFuture<'static, ExecutorResult<Rc<OpenCodeInstance>>>
    where
        F: Future<Output = ExecutorResult<Rc<OpenCodeInstance>>> + 'static,
    {
        let (completion, settled) = oneshot::channel();
        let (cleanup, cleaned) = oneshot::channel();
        let id = {
            let mut creations = self.creations.borrow_mut();
            let id = creations.next_id;
            creations.next_id = id.wrapping_add(1);
            creations.pending.insert(
                id,
                async move {
                    let _ = cleaned.await;
                }
                .boxed_local()
                .shared(),
            );
            id
        };
        let shutting_down = self.is_shutting_down.clone();
        let creations = self.creations.clone();
        spawn_local(async move {
            let result = create().await.and_then(|instance| {
                if !signal.aborted() && !shutting_down() {
                    return Ok(instance);
                }
                close_open_code_instance(&instance);
                Err(signal.reason().map_or_else(
                    || error("Error", "OpenCode runtime is shutting down"),
                    Into::into,
                ))
            });
            let _ = completion.send(result);
            let _ = cleanup.send(());
            creations.borrow_mut().pending.shift_remove(&id);
        });
        async move { settled.await? }.boxed_local()
    }

    pub async fn wait_for_cleanup(&self, grace_ms: f64) {
        let pending: Vec<_> = self.creations.borrow().pending.values().cloned().collect();
        if pending.is_empty() {
            return;
        }
        let _ = with_abortable_timeout(
            |_| async move {
                join_all(pending).await;
                Ok::<_, Box<dyn std::error::Error>>(())
            },
            Some(grace_ms),
            "OpenCode pending startup cleanup",
            None,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use tokio::task::LocalSet;

    use super::*;
    use crate::{agents::opencode::sdk_client::OpenCodeSdkClient, js::shared_error};

    fn new_instance(closes: Rc<Cell<usize>>) -> Rc<OpenCodeInstance> {
        Rc::new(OpenCodeInstance {
            client: Rc::new(OpenCodeSdkClient::new("http://127.0.0.1:12345")),
            base_url: None,
            server: None,
            close: Some(Rc::new(move || {
                closes.set(closes.get() + 1);
                Ok(())
            })),
        })
    }

    #[tokio::test(start_paused = true)]
    async fn closes_a_raw_factory_that_resolves_after_startup_was_aborted() {
        LocalSet::new()
            .run_until(async {
                let tracker = OpenCodeInstanceCreationTracker::new(Rc::new(|| false));
                let caller = AbortSignal::new();
                let closes = Rc::new(Cell::new(0));
                let instance = new_instance(closes.clone());
                let (release, released) = oneshot::channel::<()>();
                let startup = tracker.track(
                    || async move {
                        released.await?;
                        Ok(instance)
                    },
                    caller.clone(),
                );
                caller.abort(shared_error("Error", "startup scope retired"));
                tracker.wait_for_cleanup(100.0).await;
                assert_eq!(closes.get(), 0);
                release
                    .send(())
                    .expect("timed-out wait did not cancel the factory");
                tracker.wait_for_cleanup(100.0).await;
                assert_eq!(closes.get(), 1);
                assert_eq!(
                    startup.await.err().expect("startup refused").to_string(),
                    "startup scope retired"
                );
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn closes_a_factory_that_resolves_after_shutdown_even_if_its_signal_is_open() {
        LocalSet::new()
            .run_until(async {
                let shutting_down = Rc::new(Cell::new(false));
                let tracker = OpenCodeInstanceCreationTracker::new(Rc::new({
                    let shutting_down = shutting_down.clone();
                    move || shutting_down.get()
                }));
                let closes = Rc::new(Cell::new(0));
                let instance = new_instance(closes.clone());
                let (entered, entering) = oneshot::channel();
                let (release, released) = oneshot::channel();
                let startup = tracker.track(
                    || async move {
                        entered.send(()).expect("startup barrier active");
                        released.await?;
                        Ok(instance)
                    },
                    AbortSignal::new(),
                );
                entering.await.expect("entered factory");
                shutting_down.set(true);
                release.send(()).expect("factory still waits");
                tracker.wait_for_cleanup(100.0).await;
                assert_eq!(closes.get(), 1);
                assert_eq!(
                    startup.await.err().expect("startup refused").to_string(),
                    "OpenCode runtime is shutting down"
                );
            })
            .await;
    }
}
