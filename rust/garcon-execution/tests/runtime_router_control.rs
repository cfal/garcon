use std::{cell::RefCell, path::Path, rc::Rc, time::Duration};

use async_trait::async_trait;
use garcon_base::{
    errors::error_metadata,
    executor_disconnect::{ExecutorSessionLostError, as_agent_call_error},
    log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_transient_feed::ChatTransientControlAction,
};
use garcon_execution::{
    agent_registry::AgentRegistry,
    runtime_router::{
        AgentRuntimeRouter, AgentRuntimeRouterOptions, RouterPermissionClaim, RoutingChat,
        RuntimeRouterChats, RuntimeRouterIntegrations, RuntimeRouterLedger,
    },
    session_types::{AgentSteerOptions, PersistedChatExecutionConfig},
    types::ExecutionOperationResult,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    producer::{AgentPermissionRespondRequest, AgentPermissions},
    resources::{
        AgentPermissionResponseKind, AgentPermissionResponseRef, AgentResourceRef,
        AgentResourceScope, ExecutorCallOptions,
    },
    services::{
        AgentCommands, AgentSteerRequest, AgentSteerResult, AgentSteerTarget,
        AgentSteerTargetRequest, AgentSteering,
    },
};
use garcon_js::OptionalNullable;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{Notify, oneshot},
    task::LocalSet,
};

const CHAT: &str = "chat-1";
const OCCURRENCE: &str = "incarnation-1";
const REMOTE: &str = "executor-a";

fn wire(value: &impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(value).unwrap()).unwrap()
}

fn decision() -> PermissionDecisionPayload {
    PermissionDecisionPayload {
        allow: true,
        always_allow: None,
        response: None,
    }
}

fn control() -> ChatTransientControlAction {
    ChatTransientControlAction {
        server_instance_id: "server-1".into(),
        chat_id: CHAT.into(),
        run_id: "run-1".into(),
        permission_occurrence_id: OCCURRENCE.into(),
    }
}

fn outcome<T: Serialize>(result: ExecutionOperationResult<T>) -> Value {
    match result {
        Ok(value) => wire(&value),
        Err(error) => json!({
            "error":error.to_string(),
            "code":error_metadata(error.as_ref()).code,
            "outcome":as_agent_call_error(error.as_ref()).map(|error| error.outcome.as_str()),
        }),
    }
}

type Effects = Rc<RefCell<Vec<Value>>>;

struct Ports {
    mode: String,
    effects: Effects,
    pending: RefCell<Option<oneshot::Receiver<()>>>,
    claim_done: Rc<Notify>,
}

impl Ports {
    fn push(&self, event: Value) {
        self.effects.borrow_mut().push(event);
    }
}

impl RuntimeRouterChats for Ports {
    fn get_chat(&self, _: &str) -> Option<RoutingChat> {
        (self.mode != "missing-chat").then(|| RoutingChat {
            agent_id: "test".into(),
            native_session: None,
            agent_session_id: (self.mode != "no-session").then(|| "session-1".into()),
            execution: PersistedChatExecutionConfig {
                executor_id: OptionalNullable::some(REMOTE.into()),
                project_path: Some("/repo".into()),
                model: Some("model".into()),
                ..PersistedChatExecutionConfig::default()
            },
        })
    }
}

#[async_trait(?Send)]
impl AgentPermissions for Ports {
    async fn respond(
        &self,
        request: AgentPermissionRespondRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutionOperationResult<()> {
        self.push(json!([
            "respond",
            request.response.id,
            request.response.scope.executor_id,
            wire(&request.decision),
            options.and_then(|options| options.dispatch_deadline)
        ]));
        let pending = self.pending.borrow_mut().take();
        if let Some(pending) = pending {
            pending.await?;
        }
        let outcome = match self.mode.as_str() {
            "lost" => {
                return Err(ExecutorSessionLostError::new(
                    AgentDeliveryOutcome::NotDispatched,
                    "Connection lost",
                )
                .into());
            }
            "not-dispatched" => AgentDeliveryOutcome::NotDispatched,
            "rejected" => AgentDeliveryOutcome::Rejected,
            "unknown" => AgentDeliveryOutcome::Unknown,
            _ => return Ok(()),
        };
        Err(AgentCallError::new(outcome, "Provider failure").into())
    }
}

#[async_trait(?Send)]
impl AgentSteering for Ports {
    async fn capture_target(
        &self,
        _: AgentSteerTargetRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>> {
        unreachable!("this trace drives a captured target")
    }
    async fn steer(
        &self,
        request: AgentSteerRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutionOperationResult<AgentSteerResult> {
        self.push(json!([
            "steer",
            request.chat_id,
            request.project_path,
            request.agent_session_id,
            request.input,
            request.client_message_id,
            options.and_then(|options| options.dispatch_deadline)
        ]));
        if self.mode == "lost" {
            return Err(ExecutorSessionLostError::new(
                AgentDeliveryOutcome::Unknown,
                "Connection lost",
            )
            .into());
        }
        Ok(AgentSteerResult::Accepted)
    }
}

struct Directory(Rc<Ports>);

impl RuntimeRouterIntegrations for Directory {
    fn permissions(
        &self,
        agent: &str,
        executor: Option<&str>,
    ) -> ExecutionOperationResult<Rc<dyn AgentPermissions>> {
        self.0.push(json!(["require", agent, executor]));
        if self.0.mode == "lookup-failure" {
            return Err(std::io::Error::other("Executor unavailable").into());
        }
        Ok(self.0.clone())
    }
    fn steering(
        &self,
        agent: &str,
        executor: Option<&str>,
    ) -> ExecutionOperationResult<Option<Rc<dyn AgentSteering>>> {
        self.0.push(json!(["require", agent, executor]));
        Ok((self.0.mode != "unsupported").then(|| self.0.clone() as Rc<dyn AgentSteering>))
    }
    fn local_agent_ids(&self) -> ExecutionOperationResult<Vec<String>> {
        Ok(vec!["test".into(), "other".into()])
    }
    fn find_commands(
        &self,
        _: &str,
        _: Option<&str>,
    ) -> ExecutionOperationResult<Option<Rc<dyn AgentCommands>>> {
        Ok(None)
    }
}

struct Claim {
    response: AgentPermissionResponseRef,
    effects: Effects,
    done: Rc<Notify>,
}

impl RouterPermissionClaim for Claim {
    fn response(&self) -> &AgentPermissionResponseRef {
        &self.response
    }
    fn abandon(self: Box<Self>) -> ExecutionOperationResult<()> {
        self.effects
            .borrow_mut()
            .push(json!(["abandon", self.response.id]));
        self.done.notify_one();
        Ok(())
    }
    fn retire(self: Box<Self>) -> ExecutionOperationResult<()> {
        self.effects
            .borrow_mut()
            .push(json!(["retire", self.response.id]));
        self.done.notify_one();
        Ok(())
    }
    fn complete(
        self: Box<Self>,
        decision: PermissionDecisionPayload,
    ) -> ExecutionOperationResult<()> {
        self.effects
            .borrow_mut()
            .push(json!(["complete", self.response.id, wire(&decision)]));
        self.done.notify_one();
        Ok(())
    }
}

impl RuntimeRouterLedger for Ports {
    fn active_chat_ids(&self) -> Vec<String> {
        match self.mode.as_str() {
            "running" => vec![CHAT.into()],
            "several-running" => vec!["chat-3".into(), CHAT.into(), "chat-2".into()],
            _ => Vec::new(),
        }
    }
    fn is_run_active(&self, chat: &str) -> bool {
        self.mode == "running" && chat == CHAT
    }
    fn claim_permission_resolution(
        &self,
        control: &ChatTransientControlAction,
    ) -> ExecutionOperationResult<Box<dyn RouterPermissionClaim>> {
        self.push(json!(["claim", control.permission_occurrence_id]));
        Ok(Box::new(Claim {
            effects: self.effects.clone(),
            done: self.claim_done.clone(),
            response: AgentResourceRef {
                id: control.permission_occurrence_id.clone(),
                kind: AgentPermissionResponseKind::PermissionResponse,
                scope: AgentResourceScope {
                    executor_id: if self.mode == "wrong-target" {
                        "executor-b"
                    } else {
                        REMOTE
                    }
                    .into(),
                    instance_id: "test-instance".into(),
                    integration_id: "test".into(),
                },
            },
        }))
    }
    fn take_prepared_input(&self, chat: &str, message: &str) -> ExecutionOperationResult<()> {
        self.push(json!(["take", chat, message]));
        Ok(())
    }
}

fn router_options(mode: &str) -> (AgentRuntimeRouterOptions, Rc<Ports>) {
    let ports = Rc::new(Ports {
        mode: mode.into(),
        effects: Rc::default(),
        pending: RefCell::default(),
        claim_done: Rc::default(),
    });
    let options = AgentRuntimeRouterOptions {
        registry: ports.clone(),
        directory: Rc::new(Directory(ports.clone())),
        ledger: ports.clone(),
        unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(create_logger(
            "test",
        )))),
    };
    (options, ports)
}

fn fixture(mode: &str) -> (AgentRuntimeRouter, Rc<Ports>) {
    let (options, ports) = router_options(mode);
    (AgentRuntimeRouter::new(options), ports)
}

async fn permission_trace(mode: &str) -> Value {
    let (router, ports) = fixture(mode);
    let mut control = control();
    if mode == "wrong-occurrence" {
        control.permission_occurrence_id = "other".into();
    }
    let occurrence = if mode == "empty-occurrence" {
        ""
    } else {
        OCCURRENCE
    };
    let value = outcome(
        router
            .resolve_permission(CHAT, occurrence, decision(), &control, 1000.0)
            .await,
    );
    json!({"value":value,"effects":&*ports.effects.borrow()})
}

async fn steer_trace(mode: &str) -> Value {
    let (router, ports) = fixture(mode);
    let options = AgentSteerOptions {
        question_reply: None,
        client_request_id: "request".into(),
        client_message_id: "message".into(),
        transcript_view_id: "view".into(),
    };
    let value = outcome(
        router
            .steer_input(
                CHAT,
                "content",
                &options,
                None,
                Box::new(|| {
                    Box::pin(async {
                        ports.push(json!(["prepare"]));
                        if mode == "blocked" {
                            Err(std::io::Error::other("Target changed").into())
                        } else {
                            Ok(())
                        }
                    })
                }),
                Some(1234.0),
            )
            .await,
    );
    json!({"value":value,"effects":&*ports.effects.borrow()})
}

fn running_trace(active: bool) -> Value {
    let (options, _) = router_options(if active { "running" } else { "idle" });
    let registry = AgentRegistry::new(options);
    json!({
        "chat":registry.is_chat_running(CHAT),
        "agent":registry.is_agent_session_running("test",Some("session-1"),Some(REMOTE)),
        "local":registry.is_agent_session_running("test",Some("session-1"),None),
        "missing":registry.is_agent_session_running("test",Some(""),Some(REMOTE)),
        "sessions":registry.get_running_sessions().unwrap(),
        "chats":registry.get_running_chat_ids_snapshot(),
        "count":registry.get_running_session_count(),
    })
}

#[test]
fn registry_snapshot_is_sorted_and_not_filtered_by_chat_lookup() {
    let (options, _) = router_options("several-running");
    let registry = AgentRegistry::new(options);
    let mut chats = registry.get_running_chat_ids_snapshot();
    assert_eq!(chats, [CHAT, "chat-2", "chat-3"]);
    chats.clear();
    assert_eq!(
        registry.get_running_chat_ids_snapshot(),
        [CHAT, "chat-2", "chat-3"]
    );
}

#[test]
fn runtime_router_control_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/runtime-router-control");
    replay(dir, |name, args| {
        let variant = || {
            text(name, args.first())?
                .ok_or_else(|| CaseError::undeliverable("expected runtime router scenario"))
        };
        Ok(match name {
            "routerPermissionTrace" => runtime.block_on(permission_trace(variant()?)),
            "routerSteerTrace" => runtime.block_on(steer_trace(variant()?)),
            "routerRunningTrace" => running_trace(
                unknown(name, args.first())?
                    .as_bool()
                    .ok_or_else(|| CaseError::undeliverable("expected running boolean"))?,
            ),
            _ => return Err(CaseError::unhandled(name)),
        })
    });
}

#[tokio::test]
async fn definite_session_loss_abandons_the_claim_for_retry() {
    let trace = permission_trace("lost").await;
    assert_eq!(trace["value"]["outcome"], "not-dispatched");
    assert_eq!(trace["effects"][3], json!(["abandon", OCCURRENCE]));
}

#[tokio::test]
async fn dropping_the_permission_waiter_does_not_strand_its_claim() {
    LocalSet::new()
        .run_until(async {
            let (router, ports) = fixture("pending");
            let (release, pending) = oneshot::channel();
            *ports.pending.borrow_mut() = Some(pending);
            let control = control();
            let mut resolving =
                Box::pin(router.resolve_permission(CHAT, OCCURRENCE, decision(), &control, 1000.0));
            assert!(futures::poll!(resolving.as_mut()).is_pending());
            drop(resolving);
            release.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), ports.claim_done.notified())
                .await
                .unwrap();
            assert_eq!(
                ports.effects.borrow()[3],
                json!(["complete",OCCURRENCE,{"allow":true}])
            );
        })
        .await;
}

#[tokio::test]
async fn a_failed_prepare_does_not_consume_input_or_steer() {
    let trace = steer_trace("blocked").await;
    assert_eq!(
        trace["effects"],
        json!([["require", "test", REMOTE], ["prepare"]])
    );
    assert_eq!(trace["value"]["error"], "Target changed");
}
