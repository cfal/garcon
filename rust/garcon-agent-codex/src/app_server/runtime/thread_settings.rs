use std::{cell::RefCell, rc::Rc, time::Duration};

use futures::{FutureExt, future::LocalBoxFuture, try_join};
use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    resources::ExecutorResult,
};
use tokio::sync::{Mutex, oneshot};

use super::super::{
    client::CodexAppServerClient,
    request_builders::{
        CodexConfirmedThreadSettings, CodexThreadConfiguration, CodexThreadSettings,
        CodexThreadSettingsTarget, build_thread_settings_update_params,
        codex_thread_settings_target, thread_settings_match, thread_settings_target_from_snapshot,
    },
};

struct SettingsWaiter {
    generation: u64,
    target: CodexThreadSettingsTarget,
    sender: oneshot::Sender<ExecutorResult<()>>,
}

struct ThreadState {
    confirmed: CodexConfirmedThreadSettings,
    permission_mode: PermissionMode,
    provider_owns_effort: bool,
    pending: Option<SettingsWaiter>,
    fenced: bool,
    reservations: usize,
    next_generation: u64,
    retired: bool,
}

struct ThreadSettings {
    client: CodexAppServerClient,
    thread_id: String,
    timeout: Duration,
    updates: Mutex<()>,
    state: RefCell<ThreadState>,
}

#[derive(Clone)]
pub struct CodexSourceThreadSettings(Rc<ThreadSettings>);

impl CodexSourceThreadSettings {
    pub fn new(
        client: CodexAppServerClient,
        thread_id: String,
        confirmed: CodexConfirmedThreadSettings,
        provider_owns_effort: bool,
        timeout: Duration,
    ) -> Self {
        let permission_mode = confirmed.permission_mode;
        Self(Rc::new(ThreadSettings {
            client,
            thread_id,
            timeout,
            updates: Mutex::new(()),
            state: RefCell::new(ThreadState {
                confirmed,
                permission_mode,
                provider_owns_effort,
                pending: None,
                fenced: false,
                reservations: 0,
                next_generation: 0,
                retired: false,
            }),
        }))
    }

    pub fn update(
        &self,
        configuration: &CodexThreadConfiguration,
    ) -> LocalBoxFuture<'static, ExecutorResult<()>> {
        let target = codex_thread_settings_target(configuration);
        self.0.state.borrow_mut().reservations += 1;
        let source = self.clone();
        let task = tokio::task::spawn_local(async move {
            let result = source.apply_thread_settings(target).await;
            source.0.state.borrow_mut().reservations -= 1;
            result
        });
        async move { task.await? }.boxed_local()
    }

    pub fn handle_updated(&self, settings: &CodexThreadSettings) {
        let mut state = self.0.state.borrow_mut();
        if state.retired {
            return;
        }
        let confirmed = thread_settings_target_from_snapshot(settings, state.permission_mode);
        let matches = state
            .pending
            .as_ref()
            .is_some_and(|pending| thread_settings_match(&confirmed, &pending.target));
        state.confirmed = confirmed;
        if matches && let Some(pending) = state.pending.take() {
            state.permission_mode = pending.target.permission_mode;
            let _ = pending.sender.send(Ok(()));
        }
    }

    pub fn retire(&self) {
        let pending = {
            let mut state = self.0.state.borrow_mut();
            state.retired = true;
            state.pending.take()
        };
        if let Some(pending) = pending {
            let _ = pending.sender.send(Err(std::io::Error::other(
                "Codex source retired before settings were confirmed",
            )
            .into()));
        }
    }

    pub fn permission_mode(&self) -> PermissionMode {
        self.0.state.borrow().permission_mode
    }

    pub fn is_fenced(&self) -> bool {
        self.0.state.borrow().fenced
    }

    pub fn has_pending_configuration(&self) -> bool {
        let state = self.0.state.borrow();
        state.pending.is_some() || state.reservations > 0
    }

    pub fn provider_owns_effort(&self) -> bool {
        self.0.state.borrow().provider_owns_effort
    }

    pub fn confirmed(&self) -> CodexConfirmedThreadSettings {
        self.0.state.borrow().confirmed.clone()
    }

    pub(super) async fn with_delivery<T>(&self, delivery: impl Future<Output = T>) -> T {
        let _exclusive = self.0.updates.lock().await;
        delivery.await
    }

    async fn apply_thread_settings(&self, target: CodexThreadSettingsTarget) -> ExecutorResult<()> {
        let _exclusive = self.0.updates.lock().await;
        let (generation, confirmation) = {
            let mut state = self.0.state.borrow_mut();
            if state.retired {
                return Err(Box::new(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::SESSION_BUSY,
                    "Codex session changed while updating settings",
                    true,
                    None,
                )));
            }
            if state.fenced {
                return Err(Box::new(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::INVALID_SETTINGS,
                    "Codex settings are fenced after an ambiguous update",
                    false,
                    None,
                )));
            }
            // Records explicit intent before a confirmation can arrive ahead of the RPC response.
            if target.effort.is_some() {
                state.provider_owns_effort = false;
            }
            if thread_settings_match(&state.confirmed, &target) {
                state.permission_mode = target.permission_mode;
                return Ok(());
            }
            let (sender, confirmation) = oneshot::channel();
            let generation = state.next_generation;
            state.next_generation += 1;
            state.pending = Some(SettingsWaiter {
                generation,
                target: target.clone(),
                sender,
            });
            (generation, confirmation)
        };

        let params = build_thread_settings_update_params(&self.0.thread_id, &target);
        let sent = self
            .0
            .client
            .request("thread/settings/update", Some(&params), None);
        let confirmed = async {
            match tokio::time::timeout(self.0.timeout, confirmation).await {
                Ok(result) => result?,
                Err(_) => {
                    self.clear_waiter(generation, true);
                    Err(Box::new(AgentIntegrationError::new(
                        AgentIntegrationErrorCode::TIMEOUT,
                        "Codex thread settings confirmation timed out; automatic turns are fenced",
                        false,
                        None,
                    )) as Box<dyn std::error::Error>)
                }
            }
        };
        let outcome = try_join!(sent, confirmed);
        self.clear_waiter(generation, false);
        outcome.map(|_| ())
    }

    fn clear_waiter(&self, generation: u64, timed_out: bool) {
        let mut state = self.0.state.borrow_mut();
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.generation == generation)
        {
            state.pending = None;
            state.fenced |= timed_out;
        }
    }
}
