//! Ports `server-agents/opencode/src/agents/opencode/steering.ts`.

use std::{cell::RefCell, rc::Rc};

use futures::future::LocalBoxFuture;
use garcon_agents_common::execution::runtime_events::{
    PrepareDelivery, RuntimeSteerRequest, RuntimeSteerTarget,
};
use garcon_interface::{
    resources::ExecutorResult,
    services::{
        AgentSteerFailureOutcome, AgentSteerRejectionReason as Rejection, AgentSteerResult,
    },
};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::{sync::oneshot, task::spawn_local};

use super::{
    endpoint_coordinator::{OpenCodeEndpointRequest, OpenCodeRequestControl},
    prompt::build_prompt_body,
    request_control::with_abortable_timeout,
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    sdk_result::{
        OpenCodeRequestScope, OpenCodeSdkResult, has_open_code_result_error,
        open_code_result_error_message, throw_open_code_result_error, with_open_code_request_scope,
    },
    sse_events::SseEvent,
    turn_events::{
        OpenCodeSession, OpenCodeTurnContext, SessionStatus, create_open_code_prompt_part_id,
        observe_open_code_steering_part, open_code_turn_requires_provider_quiescence,
    },
};

type GetClient = Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<Rc<dyn OpenCodeClient>>>>;
type RunScopedRequest = Rc<
    dyn Fn(OpenCodeEndpointRequest) -> LocalBoxFuture<'static, ExecutorResult<OpenCodeSdkResult>>,
>;
type GetSession = Rc<dyn Fn(&str) -> Option<OpenCodeSession>>;
type ReleaseDeferred = Rc<dyn Fn(&str, &OpenCodeSession)>;
type BindOperationPart = Rc<dyn Fn(&OpenCodeTurnContext, &str) -> bool>;
type UnbindOperationPart = Rc<dyn Fn(&OpenCodeTurnContext, &str)>;

pub struct OpenCodeSteeringOptions {
    pub request_timeout_ms: f64,
    pub get_session: GetSession,
    pub get_client: GetClient,
    pub run_scoped_request: RunScopedRequest,
    pub release_deferred_terminal: ReleaseDeferred,
    pub bind_operation_part: BindOperationPart,
    pub unbind_operation_part: UnbindOperationPart,
    pub new_id: Rc<dyn Fn() -> String>,
}

#[derive(Clone)]
struct CapturedOpenCodeSteerTarget {
    session: OpenCodeSession,
    turn: OpenCodeTurnContext,
}

struct OpenCodeSteerTarget {
    owner: Rc<()>,
    captured: RefCell<Option<CapturedOpenCodeSteerTarget>>,
}

struct PendingOpenCodeSteeringAcknowledgement {
    target: CapturedOpenCodeSteerTarget,
    resolve: oneshot::Sender<()>,
}

pub struct OpenCodeSteeringController {
    options: OpenCodeSteeringOptions,
    owner: Rc<()>,
    acknowledgements: RefCell<IndexMap<String, PendingOpenCodeSteeringAcknowledgement>>,
}

struct SteeringDelivery {
    target: CapturedOpenCodeSteerTarget,
    agent_session_id: String,
    part_id: String,
    request: OpenCodeEndpointRequest,
    prepare: PrepareDelivery,
    acknowledgement: oneshot::Receiver<()>,
}

impl OpenCodeSteeringController {
    pub fn new(options: OpenCodeSteeringOptions) -> Rc<Self> {
        Rc::new(Self {
            options,
            owner: Rc::new(()),
            acknowledgements: RefCell::default(),
        })
    }

    pub fn capture_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        let session = (self.options.get_session)(agent_session_id)?;
        let data = session.borrow();
        let turn = data.turn.borrow();
        if turn.compaction
            || data.status != SessionStatus::Running
            || data.aborting == Some(true)
            || turn
                .provider_message_id
                .as_ref()
                .is_none_or(String::is_empty)
        {
            return None;
        }
        Some(Rc::new(OpenCodeSteerTarget {
            owner: self.owner.clone(),
            captured: RefCell::new(Some(CapturedOpenCodeSteerTarget {
                session: session.clone(),
                turn: data.turn.clone(),
            })),
        }))
    }

    pub async fn steer(
        self: &Rc<Self>,
        request: RuntimeSteerRequest,
    ) -> ExecutorResult<AgentSteerResult> {
        let captured = request
            .target
            .as_ref()
            .and_then(|target| target.downcast_ref::<OpenCodeSteerTarget>())
            .filter(|target| Rc::ptr_eq(&target.owner, &self.owner))
            .and_then(|target| target.captured.take());
        let Some(captured) = captured else {
            return Ok(no_active_turn());
        };
        let Some(session) = (self.options.get_session)(&request.agent_session_id) else {
            return Ok(turn_changed());
        };
        {
            let data = session.borrow();
            if session != captured.session || data.turn != captured.turn {
                return Ok(turn_changed());
            }
            if data.status != SessionStatus::Running
                || data.aborting == Some(true)
                || data.chat_id != request.chat_id
            {
                return Ok(no_active_turn());
            }
        }
        if garcon_js::trim(&request.input).is_empty() {
            return Ok(rejected_steer(
                Rejection::InvalidInput,
                "OpenCode rejected the steering input",
            ));
        }

        let client = (self.options.get_client)().await?;
        if (self.options.get_session)(&request.agent_session_id).as_ref() != Some(&session) {
            return Ok(turn_changed());
        }
        let (model, thinking, scope) = {
            let data = session.borrow();
            if data.status != SessionStatus::Running
                || data.aborting == Some(true)
                || data.turn != captured.turn
            {
                return Ok(turn_changed());
            }
            (
                data.model.clone(),
                data.thinking_variant.clone(),
                OpenCodeRequestScope {
                    directory: data.directory.clone(),
                },
            )
        };
        let part_id = create_open_code_prompt_part_id(self.options.new_id.as_ref());
        let body = build_prompt_body(
            &request.input,
            model.as_deref(),
            &part_id,
            &[],
            thinking.as_deref(),
        );
        if !(self.options.bind_operation_part)(&captured.turn, &part_id) {
            return Ok(turn_changed());
        }
        let (resolve, acknowledgement) = oneshot::channel();
        captured
            .turn
            .borrow_mut()
            .provider_steering_part_ids
            .insert(part_id.clone());
        self.acknowledgements.borrow_mut().insert(
            part_id.clone(),
            PendingOpenCodeSteeringAcknowledgement {
                target: captured.clone(),
                resolve,
            },
        );
        session.borrow_mut().active_steering_deliveries += 1;

        let mut parameters = Map::from_iter([(
            "sessionID".to_owned(),
            Value::from(request.agent_session_id.clone()),
        )]);
        parameters.extend(body);
        let delivery = SteeringDelivery {
            target: captured,
            agent_session_id: request.agent_session_id,
            part_id,
            request: OpenCodeEndpointRequest {
                client,
                label: "OpenCode steering submit",
                operation: OpenCodeRequest::SessionPromptAsync,
                parameters: with_open_code_request_scope(parameters, &scope),
                control: OpenCodeRequestControl::default(),
            },
            prepare: request.prepare_delivery,
            acknowledgement,
        };
        let controller = self.clone();
        spawn_local(async move { controller.deliver(delivery).await }).await?
    }

    async fn deliver(&self, delivery: SteeringDelivery) -> ExecutorResult<AgentSteerResult> {
        let SteeringDelivery {
            target,
            agent_session_id,
            part_id,
            request,
            prepare,
            acknowledgement,
        } = delivery;
        let (result, preserve_correlation) = self
            .deliver_to_provider(&target, request, prepare, acknowledgement)
            .await;
        {
            let mut acknowledgements = self.acknowledgements.borrow_mut();
            if acknowledgements.get(&part_id).is_some_and(|pending| {
                pending.target.session == target.session && pending.target.turn == target.turn
            }) {
                acknowledgements.shift_remove(&part_id);
            }
        }
        if !preserve_correlation {
            target
                .turn
                .borrow_mut()
                .provider_steering_part_ids
                .shift_remove(&part_id);
            (self.options.unbind_operation_part)(&target.turn, &part_id);
        }
        self.release_delivery(&agent_session_id, &target);
        result
    }

    async fn deliver_to_provider(
        &self,
        target: &CapturedOpenCodeSteerTarget,
        request: OpenCodeEndpointRequest,
        prepare: PrepareDelivery,
        acknowledgement: oneshot::Receiver<()>,
    ) -> (ExecutorResult<AgentSteerResult>, bool) {
        if let Err(error) = prepare().await {
            return (Err(error), false);
        }
        let result = match (self.options.run_scoped_request)(request).await {
            Ok(result) => result,
            Err(_) => return (Ok(mark_unconfirmed(target)), true),
        };
        if has_open_code_result_error(&result) {
            return (Ok(classify_steer_rejection(&result)), false);
        }
        let acknowledged = with_abortable_timeout(
            |_| async move { Ok::<_, Box<dyn std::error::Error>>(acknowledgement.await?) },
            Some(self.options.request_timeout_ms),
            "OpenCode steering acknowledgement",
            None,
        )
        .await;
        if acknowledged.is_err() {
            return (Ok(mark_unconfirmed(target)), true);
        }
        (Ok(AgentSteerResult::Accepted), true)
    }

    pub fn observe_acknowledgement(&self, session: &OpenCodeSession, event: &SseEvent) {
        let Some(part_id) = observe_open_code_steering_part(session, event) else {
            return;
        };
        let mut acknowledgements = self.acknowledgements.borrow_mut();
        if acknowledgements.get(&part_id).is_some_and(|pending| {
            pending.target.session == *session && pending.target.turn == session.borrow().turn
        }) && let Some(pending) = acknowledgements.shift_remove(&part_id)
        {
            let _ = pending.resolve.send(());
        }
    }

    pub fn stage_pending_cleanup(&self, session: &OpenCodeSession) {
        let mut data = session.borrow_mut();
        let earliest = data
            .turn
            .borrow()
            .pending_steering_message_ids
            .iter()
            .min_by(|a, b| garcon_js::utf16::cmp(a, b))
            .cloned();
        if let Some(earliest) = earliest.filter(|id| !id.is_empty())
            && data
                .pending_steering_revert_message_id
                .as_deref()
                .is_none_or(|id| id.is_empty() || garcon_js::utf16::cmp(&earliest, id).is_lt())
        {
            data.pending_steering_revert_message_id = Some(earliest);
        }
    }

    pub async fn remove_unconsumed(
        &self,
        client: Rc<dyn OpenCodeClient>,
        agent_session_id: &str,
        session: &OpenCodeSession,
        scope: &OpenCodeRequestScope,
    ) -> ExecutorResult<()> {
        let message_id = session.borrow().pending_steering_revert_message_id.clone();
        let Some(message_id) = message_id.filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        let parameters = Map::from_iter([
            ("sessionID".to_owned(), Value::from(agent_session_id)),
            ("messageID".to_owned(), Value::from(message_id)),
        ]);
        let result = (self.options.run_scoped_request)(OpenCodeEndpointRequest {
            client,
            label: "OpenCode unconsumed steering revert",
            operation: OpenCodeRequest::SessionRevert,
            parameters: with_open_code_request_scope(parameters, scope),
            control: OpenCodeRequestControl::default(),
        })
        .await?;
        throw_open_code_result_error(&result, "OpenCode unconsumed steering revert failed")?;
        session.borrow_mut().pending_steering_revert_message_id = None;
        Ok(())
    }

    fn release_delivery(&self, agent_session_id: &str, target: &CapturedOpenCodeSteerTarget) {
        {
            let mut session = target.session.borrow_mut();
            session.active_steering_deliveries =
                session.active_steering_deliveries.saturating_sub(1);
            if session.active_steering_deliveries > 0 || session.turn != target.turn {
                return;
            }
        }
        (self.options.release_deferred_terminal)(agent_session_id, &target.session);
        let mut session = target.session.borrow_mut();
        if session.status == SessionStatus::Running {
            session.provider_work_requires_quiescence =
                open_code_turn_requires_provider_quiescence(&target.turn);
        }
    }
}

fn rejected_steer(reason: Rejection, message: &str) -> AgentSteerResult {
    AgentSteerResult::Rejected {
        reason,
        message: message.to_owned(),
    }
}

fn no_active_turn() -> AgentSteerResult {
    rejected_steer(Rejection::NoActiveTurn, "No active OpenCode turn")
}

fn turn_changed() -> AgentSteerResult {
    rejected_steer(Rejection::TurnChanged, "The active OpenCode turn changed")
}

fn mark_unconfirmed(target: &CapturedOpenCodeSteerTarget) -> AgentSteerResult {
    target
        .turn
        .borrow_mut()
        .provider_steering_delivery_unconfirmed = true;
    target
        .session
        .borrow_mut()
        .provider_work_requires_quiescence =
        open_code_turn_requires_provider_quiescence(&target.turn);
    AgentSteerResult::Failed {
        outcome: AgentSteerFailureOutcome::Unknown,
        message: "OpenCode steering delivery could not be confirmed".to_owned(),
    }
}

fn classify_steer_rejection(result: &Value) -> AgentSteerResult {
    let message = open_code_result_error_message(result, "OpenCode rejected the steering input")
        .to_ascii_lowercase();
    let within_line = |prefix, markers: &[&str]| {
        message
            .split(['\n', '\r', '\u{2028}', '\u{2029}'])
            .any(|line| {
                line.split_once(prefix)
                    .is_some_and(|(_, tail)| markers.iter().any(|marker| tail.contains(*marker)))
            })
    };
    if message.contains("empty input")
        || message.contains("invalid input")
        || within_line("input", &["too large", "limit", "maximum"])
    {
        return rejected_steer(
            Rejection::InvalidInput,
            "OpenCode rejected the steering input",
        );
    }
    if message.contains("no active")
        || message.contains("not running")
        || within_line("session", &["idle", "not found"])
    {
        return no_active_turn();
    }
    rejected_steer(
        Rejection::ProviderRejected,
        "OpenCode rejected the steering input",
    )
}

#[cfg(test)]
mod tests;
