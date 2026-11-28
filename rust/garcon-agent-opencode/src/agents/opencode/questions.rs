//! Ports `server-agents/opencode/src/agents/opencode/questions.ts`.

use std::{cell::RefCell, error::Error, rc::Rc};

use async_trait::async_trait;
use futures::{FutureExt, future::LocalBoxFuture};
use garcon_agents_common::execution::runtime_events::{
    AgentRuntimeEvent, AgentRuntimeOperation, RuntimePermissionResponse,
};
use garcon_contract::chat_command_contracts::{
    PermissionDecisionPayload, PermissionDecisionResponse,
};
use garcon_contract::chat_message_coercion::AskUserQuestionPrompt;
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_interface::{
    host::AgentLogger,
    producer::{
        AgentProviderPermissionLifecycle, AgentRequestedPermission, AgentTerminalPermission,
    },
    resources::ExecutorResult,
};
use garcon_js::Clock;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::task::spawn_local;

use super::{
    endpoint_coordinator::{OpenCodeEndpointRequest, OpenCodeRequestControl},
    operation_routes::{OpenCodeOperationEventSource, Route},
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    sdk_result::{
        OpenCodeRequestScope, OpenCodeSdkResult, is_open_code_not_found_result,
        throw_open_code_result_error, with_open_code_request_scope,
    },
    sse_events::SseEvent,
    tool_use_converter::convert_open_code_question_tool_use,
    turn_events::{OpenCodeSession, SessionStatus},
};
use crate::js::{error, log_fields, own, prop};

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeQuestionRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub questions: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeQuestionDecision {
    Reply { answers: Vec<Vec<String>> },
    Reject,
}

pub fn extract_open_code_question_request(event: &SseEvent) -> Option<OpenCodeQuestionRequest> {
    if event.kind != "question.asked" {
        return None;
    }
    let properties = &event.properties;
    let tool = prop(properties, "tool").as_object();
    let request_id = prop(properties, "id")
        .as_str()
        .filter(|id| !id.is_empty())?;
    let tool_call_id = tool
        .and_then(|tool| prop(tool, "callID").as_str())
        .filter(|id| !id.is_empty())?
        .to_owned();
    let questions = prop(properties, "questions");
    questions.is_array().then(|| OpenCodeQuestionRequest {
        request_id: request_id.to_owned(),
        tool_call_id,
        questions: questions.clone(),
    })
}

// The decision's response as the record the original validates and reads.
fn response_json(response: &PermissionDecisionResponse) -> Value {
    match response {
        PermissionDecisionResponse::Provider(opaque) => opaque.as_value().clone(),
        // INFALLIBLE: a struct of strings and vectors always serializes.
        PermissionDecisionResponse::Structured(response) => {
            serde_json::to_value(response).expect("a question response serializes")
        }
    }
}

// A response is returned when it has the shape of a skipped or an answered
// question response; anything else is `None`.
fn parse_question_response(response: Option<&Value>) -> Option<&Value> {
    let response = response?;
    let object = response.as_object()?;
    if prop(object, "type").as_str() != Some("ask-user-question-response") {
        return None;
    }
    match prop(object, "outcome").as_str() {
        Some("skipped") => {
            if own(object, "reason").is_some_and(|reason| !reason.is_string()) {
                return None;
            }
            Some(response)
        }
        Some("answered") => {
            for answer in prop(object, "answers").as_array()? {
                let answer = answer.as_object()?;
                let option_ids = prop(answer, "selectedOptionIds").as_array()?;
                if prop(answer, "questionId").as_str().is_none()
                    || option_ids.iter().any(|option_id| !option_id.is_string())
                {
                    return None;
                }
            }
            Some(response)
        }
        _ => None,
    }
}

pub fn map_open_code_question_decision(
    questions: &[AskUserQuestionPrompt],
    decision: &PermissionDecisionPayload,
) -> Result<OpenCodeQuestionDecision, Box<dyn Error>> {
    let json = decision.response.as_ref().map(response_json);
    let response = parse_question_response(json.as_ref());
    let skipped =
        response.is_some_and(|response| prop(response, "outcome").as_str() == Some("skipped"));
    if !decision.allow || skipped {
        return Ok(OpenCodeQuestionDecision::Reject);
    }
    let Some(response) = response else {
        return Err(error(
            "Error",
            "OpenCode question decision is missing an answered response",
        ));
    };
    // INFALLIBLE: an answered response was validated to hold an array of answers.
    let answers = prop(response, "answers")
        .as_array()
        .expect("validated answers");
    let mut answers_by_question: IndexMap<String, Vec<String>> = IndexMap::new();
    for answer in answers {
        // INFALLIBLE: every answer was validated to be a record with a string question ID.
        let answer = answer.as_object().expect("validated answer");
        let question_id = prop(answer, "questionId")
            .as_str()
            .expect("validated question ID");
        // A later question with the same ID replaces an earlier one, as in the original's Map.
        let Some(question) = questions
            .iter()
            .rev()
            .find(|question| question.id == question_id)
        else {
            return Err(error(
                "Error",
                "OpenCode question decision contains an unknown question ID",
            ));
        };
        // INFALLIBLE: every answer was validated to hold an array of option IDs.
        let option_ids = prop(answer, "selectedOptionIds")
            .as_array()
            .expect("validated option IDs");
        let labels = option_ids
            .iter()
            .map(|option_id| {
                option_id
                    .as_str()
                    .and_then(|option_id| {
                        // A later option with the same ID labels as the original's Map keeps.
                        question
                            .options
                            .iter()
                            .rev()
                            .find(|option| option.id == option_id)
                            .map(|option| option.label.clone())
                    })
                    .ok_or_else(|| {
                        error(
                            "Error",
                            "OpenCode question decision contains an unknown option ID",
                        )
                    })
            })
            .collect::<Result<Vec<String>, Box<dyn Error>>>()?;
        answers_by_question.insert(question_id.to_owned(), labels);
    }
    Ok(OpenCodeQuestionDecision::Reply {
        answers: questions
            .iter()
            .map(|question| {
                answers_by_question
                    .get(&question.id)
                    .cloned()
                    .unwrap_or_default()
            })
            .collect(),
    })
}

type GetClient = Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<Rc<dyn OpenCodeClient>>>>;
type RunScopedRequest = Rc<
    dyn Fn(OpenCodeEndpointRequest) -> LocalBoxFuture<'static, ExecutorResult<OpenCodeSdkResult>>,
>;
type Publish = Rc<dyn Fn(&str, &AgentRuntimeOperation, AgentRuntimeEvent)>;
type GetSession = Rc<dyn Fn(&str) -> Option<OpenCodeSession>>;
type FailTurn = Rc<dyn Fn(&str, OpenCodeSession, String)>;
type Respond = Rc<dyn Fn(PermissionDecisionPayload) -> LocalBoxFuture<'static, ExecutorResult<()>>>;

pub struct OpenCodeQuestionControllerOptions {
    pub logger: Rc<dyn AgentLogger>,
    pub publish: Publish,
    pub get_client: GetClient,
    pub run_scoped_request: RunScopedRequest,
    pub get_session: GetSession,
    pub fail_turn: FailTurn,
    pub clock: Rc<dyn Clock>,
    pub new_id: Rc<dyn Fn() -> String>,
}

pub(crate) struct PendingOpenCodeDecision {
    pub occurrence_id: String,
    pub original_request_id: String,
    pub session_id: String,
    pub scope: OpenCodeRequestScope,
    pub operation: AgentRuntimeOperation,
}

impl PendingOpenCodeDecision {
    pub fn new(route: &Route, occurrence_id: String, original_request_id: String) -> Self {
        Self {
            occurrence_id,
            original_request_id,
            session_id: route.session_id.clone(),
            scope: OpenCodeRequestScope {
                directory: route.directory.clone(),
            },
            operation: route.turn.borrow().operation.clone(),
        }
    }
}

struct RuntimeResponse {
    occurrence_id: String,
    respond: Respond,
}

#[async_trait(?Send)]
impl RuntimePermissionResponse for RuntimeResponse {
    fn permission_occurrence_id(&self) -> &str {
        &self.occurrence_id
    }

    async fn respond(&self, decision: PermissionDecisionPayload) -> ExecutorResult<()> {
        (self.respond)(decision).await
    }
}

impl OpenCodeQuestionControllerOptions {
    pub(crate) fn timestamp(&self) -> String {
        // INFALLIBLE: Wall-clock time fits a JavaScript Date.
        garcon_js::to_iso_string(self.clock.now_ms()).expect("valid wall clock time")
    }

    pub(crate) fn publish_request(
        &self,
        pending: &PendingOpenCodeDecision,
        tool: ToolUseChatMessage,
        respond: Respond,
    ) {
        let occurrence_id = pending.occurrence_id.clone();
        (self.publish)(
            &pending.session_id,
            &pending.operation,
            AgentRuntimeEvent::Permission {
                run_id: pending.operation.run_id.clone(),
                lifecycle: AgentProviderPermissionLifecycle::Requested(
                    AgentRequestedPermission::Requested {
                        permission_occurrence_id: occurrence_id.clone(),
                        requested_tool: Box::new(tool),
                        options: Vec::new(),
                        reason: None,
                    },
                ),
                decision: Some(Rc::new(RuntimeResponse {
                    occurrence_id,
                    respond,
                })),
            },
        );
    }

    pub(crate) fn publish_cancellation(&self, pending: &PendingOpenCodeDecision, reason: &str) {
        (self.publish)(
            &pending.session_id,
            &pending.operation,
            AgentRuntimeEvent::Permission {
                run_id: pending.operation.run_id.clone(),
                lifecycle: AgentProviderPermissionLifecycle::Terminal(
                    AgentTerminalPermission::Cancelled {
                        permission_occurrence_id: pending.occurrence_id.clone(),
                        reason: Some(reason.to_owned()),
                    },
                ),
                decision: None,
            },
        );
    }

    pub(crate) fn run_request(
        &self,
        client: Rc<dyn OpenCodeClient>,
        label: &'static str,
        operation: OpenCodeRequest,
        body: Map<String, Value>,
        scope: &OpenCodeRequestScope,
    ) -> LocalBoxFuture<'static, ExecutorResult<OpenCodeSdkResult>> {
        (self.run_scoped_request)(OpenCodeEndpointRequest {
            client,
            label,
            operation,
            parameters: with_open_code_request_scope(body, scope),
            control: OpenCodeRequestControl::default(),
        })
    }

    pub(crate) fn run_automatic_decision(
        self: &Rc<Self>,
        client: Rc<dyn OpenCodeClient>,
        route: &Route,
        request_id: String,
        decision: OpenCodeAutomaticDecision,
    ) {
        let (label, operation, error_label, missing_label, stale_label) = match decision {
            OpenCodeAutomaticDecision::ManualBypass => (
                "OpenCode manual bypass permission reply",
                OpenCodeRequest::PermissionReply,
                "OpenCode manual bypass permission reply failed",
                "Ignoring an OpenCode reply for a missing permission request",
                "Ignoring a late OpenCode manual bypass reply failure",
            ),
            OpenCodeAutomaticDecision::RejectQuestion => (
                "OpenCode unrenderable question reject",
                OpenCodeRequest::QuestionReject,
                "OpenCode unrenderable question reject failed",
                "Ignoring an OpenCode rejection for a missing question request",
                "Ignoring a late OpenCode question rejection failure",
            ),
        };
        let mut body = Map::from_iter([("requestID".to_owned(), Value::String(request_id))]);
        if matches!(decision, OpenCodeAutomaticDecision::ManualBypass) {
            body.insert("reply".to_owned(), Value::from("once"));
        }
        let pending = self.run_request(
            client,
            label,
            operation,
            body,
            &OpenCodeRequestScope {
                directory: route.directory.clone(),
            },
        );
        let options = self.clone();
        let route = route.clone();
        spawn_local(async move {
            let result = pending.await.and_then(|result| {
                if is_open_code_not_found_result(&result) {
                    options.logger.debug(
                        missing_label,
                        Some(&log_fields([("agentSessionId", json!(route.session_id))])),
                    );
                    return Ok(());
                }
                throw_open_code_result_error(&result, error_label).map_err(Into::into)
            });
            let Err(failure) = result else {
                return;
            };
            let current = (options.get_session)(&route.session_id).filter(|session| {
                let data = session.borrow();
                data.status == SessionStatus::Running && data.turn == route.turn
            });
            if let Some(current) = current {
                (options.fail_turn)(&route.session_id, current, failure.to_string());
            } else {
                options.logger.debug(
                    stale_label,
                    Some(&log_fields([
                        ("agentSessionId", json!(route.session_id)),
                        ("error", json!(failure.to_string())),
                    ])),
                );
            }
        });
    }
}

pub(crate) enum OpenCodeAutomaticDecision {
    ManualBypass,
    RejectQuestion,
}

struct PendingOpenCodeQuestion {
    decision: PendingOpenCodeDecision,
    questions: Vec<AskUserQuestionPrompt>,
}

pub struct OpenCodeQuestionController {
    options: Rc<OpenCodeQuestionControllerOptions>,
    pending: RefCell<IndexMap<String, Rc<PendingOpenCodeQuestion>>>,
}

impl OpenCodeQuestionController {
    pub fn new(options: Rc<OpenCodeQuestionControllerOptions>) -> Rc<Self> {
        Rc::new(Self {
            options,
            pending: RefCell::default(),
        })
    }

    pub fn idle(&self) -> bool {
        self.pending.borrow().is_empty()
    }

    pub fn handle(
        self: &Rc<Self>,
        client: Rc<dyn OpenCodeClient>,
        event: &SseEvent,
        source: &OpenCodeOperationEventSource,
        route: &Route,
    ) {
        let tool_message_id = prop(event.property("tool"), "messageID").as_str();
        if !source.is_task_child()
            && tool_message_id
                .is_none_or(|id| !route.turn.borrow().assistant_message_ids.contains(id))
        {
            self.options.logger.warn(
                "Ignoring an OpenCode question for a message outside its turn",
                Some(&log_fields([
                    ("agentSessionId", json!(route.session_id)),
                    ("eventId", json!(event.id)),
                ])),
            );
            return;
        }
        let request = extract_open_code_question_request(event).and_then(|request| {
            let tool = convert_open_code_question_tool_use(
                &self.options.timestamp(),
                &request.tool_call_id,
                &request.questions,
            )?;
            Some((request, tool))
        });
        let Some((request, tool @ ToolUseChatMessage::AskUserQuestion { .. })) = request else {
            self.options.logger.warn(
                "Ignoring a malformed OpenCode question request",
                Some(&log_fields([
                    ("agentSessionId", json!(route.session_id)),
                    ("sourceSessionId", json!(source.session_id())),
                    ("eventId", json!(event.id)),
                ])),
            );
            if let Some(id) = event.property("id").as_str().filter(|id| !id.is_empty()) {
                self.options.run_automatic_decision(
                    client,
                    route,
                    id.to_owned(),
                    OpenCodeAutomaticDecision::RejectQuestion,
                );
            }
            return;
        };
        let ToolUseChatMessage::AskUserQuestion { questions, .. } = &tool else {
            return;
        };
        let id = (self.options.new_id)();
        let pending = Rc::new(PendingOpenCodeQuestion {
            decision: PendingOpenCodeDecision::new(route, id.clone(), request.request_id),
            questions: questions.clone(),
        });
        self.pending.borrow_mut().insert(id, pending.clone());
        let controller = Rc::downgrade(self);
        self.options.publish_request(
            &pending.decision,
            tool,
            Rc::new({
                let pending = pending.clone();
                move |decision| {
                    let controller = controller.upgrade();
                    let pending = pending.clone();
                    async move {
                        let controller = controller.ok_or_else(|| {
                            error("Error", "OpenCode question occurrence is no longer pending")
                        })?;
                        controller.resolve(pending, decision).await
                    }
                    .boxed_local()
                }
            }),
        );
    }

    pub fn cancel_for_session(&self, agent_session_id: &str, reason: &str) {
        let matching: Vec<_> = self
            .pending
            .borrow()
            .values()
            .filter(|pending| pending.decision.session_id == agent_session_id)
            .cloned()
            .collect();
        for pending in matching {
            self.pending
                .borrow_mut()
                .shift_remove(&pending.decision.occurrence_id);
            self.options.publish_cancellation(&pending.decision, reason);
        }
    }

    pub fn clear(&self) {
        self.pending.borrow_mut().clear();
    }

    async fn resolve(
        &self,
        pending: Rc<PendingOpenCodeQuestion>,
        decision: PermissionDecisionPayload,
    ) -> ExecutorResult<()> {
        let request = &pending.decision;
        if !self
            .pending
            .borrow()
            .get(&request.occurrence_id)
            .is_some_and(|current| Rc::ptr_eq(&pending, current))
        {
            return Err(error(
                "Error",
                "OpenCode question occurrence is no longer pending",
            ));
        }
        let response = map_open_code_question_decision(&pending.questions, &decision)?;
        let client = (self.options.get_client)().await?;
        let mut body = Map::from_iter([(
            "requestID".to_owned(),
            Value::from(request.original_request_id.clone()),
        )]);
        let (operation, label, failure) = match response {
            OpenCodeQuestionDecision::Reply { answers } => {
                body.insert("answers".to_owned(), json!(answers));
                (
                    OpenCodeRequest::QuestionReply,
                    "OpenCode question reply",
                    "OpenCode question reply failed",
                )
            }
            OpenCodeQuestionDecision::Reject => (
                OpenCodeRequest::QuestionReject,
                "OpenCode question reject",
                "OpenCode question reject failed",
            ),
        };
        let result = self
            .options
            .run_request(client, label, operation, body, &request.scope)
            .await?;
        throw_open_code_result_error(&result, failure)?;
        self.pending
            .borrow_mut()
            .shift_remove(&request.occurrence_id);
        Ok(())
    }
}
