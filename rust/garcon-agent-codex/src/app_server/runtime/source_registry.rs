use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use futures::future::LocalBoxFuture;
use garcon_interface::producer::AgentFinalResponse;
use indexmap::IndexMap;
use tokio::sync::{Mutex, Notify};

use crate::app_server::{
    client::CodexAppServerClient,
    operation_routes::CodexOperation,
    request_builders::CodexConfirmedThreadSettings,
    runtime_session_state::{CodexTurnRoutes, FinishSessionOptions, RunningStatus},
    turn_item_ledger::CodexTurnItemLedger,
};

use super::{interrupt::CodexInterrupt, thread_settings::CodexSourceThreadSettings};
use crate::service_tier::CodexServiceTier;

pub struct CodexSourceActivation {
    pub native_path: Option<String>,
    pub codex_home: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub runtime_identity: String,
    pub started_at: String,
    pub confirmed_settings: CodexConfirmedThreadSettings,
    pub provider_owns_effort: bool,
    pub settings_timeout: Duration,
    pub admitted_tier: CodexServiceTier,
}

pub(super) struct PendingFinish {
    pub options: FinishSessionOptions,
    pub operation: Option<Rc<CodexOperation>>,
    pub response: Option<AgentFinalResponse>,
}

pub struct CodexSessionSource {
    pub chat_id: String,
    pub thread_id: String,
    pub client: CodexAppServerClient,
    pub routes: RefCell<CodexTurnRoutes>,
    pub(super) native_path: RefCell<Option<String>>,
    pub codex_home: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub runtime_identity: String,
    pub(super) status: Cell<RunningStatus>,
    pub(super) started_at: RefCell<String>,
    pub(super) idle_since: Cell<Option<i64>>,
    pub(super) settings: CodexSourceThreadSettings,
    pub(super) cleanup_attachments: RefCell<Option<LocalBoxFuture<'static, ()>>>,
    pub(super) deliveries: Cell<usize>,
    pub(super) pending_finish: RefCell<Option<PendingFinish>>,
    pub(super) input_lane: Mutex<()>,
    pub(super) admitted_tier: Cell<CodexServiceTier>,
    pub(super) admitted_model: RefCell<String>,
    pub(super) capacity_retry_count: Cell<usize>,
    pub(super) pending_capacity_failure: RefCell<Option<(String, String)>>,
    pub(super) interrupt: Rc<CodexInterrupt>,
    pub(super) terminal: Notify,
    pub(super) turn_attempt: Cell<u64>,
    pub(super) items: RefCell<CodexTurnItemLedger>,
    pub(super) live_raw_results: RefCell<IndexMap<String, String>>,
}

impl CodexSessionSource {
    pub fn new(
        thread_id: String,
        client: CodexAppServerClient,
        operation: Rc<CodexOperation>,
        activation: CodexSourceActivation,
    ) -> Self {
        let model = activation.confirmed_settings.model.clone();
        let settings = CodexSourceThreadSettings::new(
            client.clone(),
            thread_id.clone(),
            activation.confirmed_settings,
            activation.provider_owns_effort,
            activation.settings_timeout,
        );
        Self {
            chat_id: operation.chat_id.clone(),
            thread_id,
            client,
            routes: RefCell::new(CodexTurnRoutes::new(operation)),
            native_path: RefCell::new(activation.native_path),
            codex_home: activation.codex_home,
            model_endpoint_id: activation.model_endpoint_id,
            runtime_identity: activation.runtime_identity,
            status: Cell::new(RunningStatus::Running),
            started_at: RefCell::new(activation.started_at),
            idle_since: Cell::new(None),
            settings,
            cleanup_attachments: RefCell::default(),
            deliveries: Cell::new(0),
            pending_finish: RefCell::default(),
            input_lane: Mutex::new(()),
            admitted_tier: Cell::new(activation.admitted_tier),
            admitted_model: RefCell::new(model),
            capacity_retry_count: Cell::new(0),
            pending_capacity_failure: RefCell::default(),
            interrupt: Rc::new(CodexInterrupt::default()),
            terminal: Notify::new(),
            turn_attempt: Cell::new(0),
            items: RefCell::default(),
            live_raw_results: RefCell::default(),
        }
    }
}

#[derive(Default)]
pub struct CodexSourceRegistry {
    active: IndexMap<String, Rc<CodexSessionSource>>,
    sources: IndexMap<usize, Rc<CodexSessionSource>>,
    latest_by_chat: IndexMap<String, Rc<CodexSessionSource>>,
}

impl CodexSourceRegistry {
    pub fn active(&self, thread_id: &str) -> Option<Rc<CodexSessionSource>> {
        self.active.get(thread_id).cloned()
    }

    pub fn latest_for_chat(&self, chat_id: &str) -> Option<Rc<CodexSessionSource>> {
        self.latest_by_chat.get(chat_id).cloned()
    }

    pub(super) fn for_client(
        &self,
        client: &CodexAppServerClient,
    ) -> Option<Rc<CodexSessionSource>> {
        self.sources.get(&client.identity()).cloned()
    }

    pub(super) fn active_sources(&self) -> impl Iterator<Item = &Rc<CodexSessionSource>> {
        self.active.values()
    }

    pub(super) fn all_sources(&self) -> impl Iterator<Item = &Rc<CodexSessionSource>> {
        self.sources.values()
    }

    pub fn session_for_client_thread(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
    ) -> Option<Rc<CodexSessionSource>> {
        self.active(thread_id)
            .filter(|source| source.client.identity() == client.identity())
    }

    pub fn source_for_client_thread(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
    ) -> Option<Rc<CodexSessionSource>> {
        self.sources
            .get(&client.identity())
            .filter(|source| source.thread_id == thread_id)
            .cloned()
    }

    pub fn source_for_client_turn(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
        turn_id: &str,
    ) -> Option<(Rc<CodexSessionSource>, Rc<CodexOperation>)> {
        let source = self.source_for_client_thread(client, thread_id)?;
        let operation = source
            .routes
            .borrow()
            .operation_for_turn(turn_id)
            .cloned()?;
        Some((source, operation))
    }

    /// Returns the previous sources for the caller to shut down.
    pub fn activate(&mut self, source: Rc<CodexSessionSource>) -> Vec<Rc<CodexSessionSource>> {
        let latest = self.latest_for_chat(&source.chat_id);
        let active = self.active(&source.thread_id);
        let mut retired = Vec::new();
        for previous in [latest, active].into_iter().flatten() {
            if !Rc::ptr_eq(&previous, &source)
                && let Some(previous) = self.retire(&previous.client)
            {
                retired.push(previous);
            }
        }
        self.active.insert(source.thread_id.clone(), source.clone());
        self.latest_by_chat
            .insert(source.chat_id.clone(), source.clone());
        self.sources.insert(source.client.identity(), source);
        retired
    }

    pub fn finish(&mut self, source: &CodexSessionSource) {
        if self
            .active
            .get(&source.thread_id)
            .is_some_and(|current| std::ptr::eq(current.as_ref(), source))
        {
            self.active.shift_remove(&source.thread_id);
        }
    }

    pub fn retire(&mut self, client: &CodexAppServerClient) -> Option<Rc<CodexSessionSource>> {
        let source = self.sources.shift_remove(&client.identity())?;
        self.finish(&source);
        if self
            .latest_by_chat
            .get(&source.chat_id)
            .is_some_and(|current| Rc::ptr_eq(current, &source))
        {
            self.latest_by_chat.shift_remove(&source.chat_id);
        }
        source.routes.borrow_mut().retire();
        source.interrupt.clear();
        source.settings.retire();
        source.terminal.notify_waiters();
        Some(source)
    }

    pub fn for_release(
        &self,
        chat_id: &str,
        thread_id: Option<&str>,
    ) -> Vec<Rc<CodexSessionSource>> {
        self.sources
            .values()
            .filter(|source| {
                source.chat_id == chat_id && Some(source.thread_id.as_str()) == thread_id
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::app_server::{
        client::CodexAppServerClientOptions,
        operation_routes::codex_operation,
        request_builders::{
            CodexThreadSettings, CodexThreadSettingsSandboxPolicy,
            thread_settings_target_from_snapshot,
        },
    };
    use garcon_contract::chat_modes::PermissionMode;

    use super::*;

    fn source(chat: &str, thread: &str, run: &str) -> Rc<CodexSessionSource> {
        let operation = codex_operation(chat, run, Rc::new(|_| {}));
        let client = CodexAppServerClient::new(CodexAppServerClientOptions::new(Rc::new(|_| {
            unreachable!("routing does not start a process")
        })));
        let source = Rc::new(CodexSessionSource::new(
            thread.into(),
            client,
            operation.clone(),
            CodexSourceActivation {
                native_path: None,
                codex_home: None,
                model_endpoint_id: None,
                runtime_identity: "synthetic".into(),
                started_at: "2026-02-21T10:00:00.000Z".into(),
                confirmed_settings: thread_settings_target_from_snapshot(
                    &CodexThreadSettings {
                        model: "model".into(),
                        service_tier: None,
                        effort: None,
                        approval_policy: serde_json::json!("never"),
                        approvals_reviewer: "user".into(),
                        sandbox_policy: CodexThreadSettingsSandboxPolicy {
                            kind: "readOnly".into(),
                            fields: serde_json::Map::new(),
                        },
                    },
                    PermissionMode::Default,
                ),
                provider_owns_effort: true,
                settings_timeout: Duration::from_secs(1),
                admitted_tier: CodexServiceTier::Default,
            },
        ));
        assert!(CodexTurnRoutes::adopt_turn(
            &source.routes,
            "turn-1",
            operation
        ));
        source
    }

    #[test]
    fn scopes_turn_identity_to_the_client_and_thread_even_after_finish() {
        let a = source("a", "thread-a", "run-a");
        let b = source("b", "thread-b", "run-b");
        let mut registry = CodexSourceRegistry::default();
        assert!(registry.activate(a.clone()).is_empty());
        assert!(registry.activate(b.clone()).is_empty());
        assert!(
            registry
                .source_for_client_turn(&a.client, "thread-b", "turn-1")
                .is_none()
        );
        assert!(
            registry
                .source_for_client_turn(&b.client, "thread-b", "foreign")
                .is_none()
        );
        registry.finish(&a);
        assert!(
            registry
                .session_for_client_thread(&a.client, "thread-a")
                .is_none()
        );
        let (source, operation) = registry
            .source_for_client_turn(&a.client, "thread-a", "turn-1")
            .unwrap();
        assert!(Rc::ptr_eq(&source, &a));
        assert_eq!(operation.run_id, "run-a");
        assert!(Rc::ptr_eq(
            &registry.for_release("a", Some("thread-a"))[0],
            &a
        ));
        assert!(registry.for_release("b", Some("thread-a")).is_empty());
        registry.retire(&a.client);
        assert!(
            registry
                .source_for_client_turn(&a.client, "thread-a", "turn-1")
                .is_none()
        );
        assert!(a.routes.borrow().operation_for_turn("turn-1").is_none());
        assert!(registry.active("thread-b").is_some());
    }

    #[test]
    fn replacing_a_source_cannot_remove_a_sibling_or_let_an_old_exit_remove_the_replacement() {
        let old = source("a", "thread-a", "old-run");
        let new = source("a", "thread-a", "new-run");
        let sibling = source("b", "thread-b", "sibling-run");
        let mut registry = CodexSourceRegistry::default();
        registry.activate(old.clone());
        registry.activate(sibling.clone());
        let retired = registry.activate(new.clone());
        assert_eq!(retired.len(), 1);
        assert!(Rc::ptr_eq(&retired[0], &old));
        assert!(registry.retire(&old.client).is_none());
        assert!(Rc::ptr_eq(&registry.latest_for_chat("a").unwrap(), &new));
        assert!(Rc::ptr_eq(&registry.active("thread-b").unwrap(), &sibling));
    }
}
