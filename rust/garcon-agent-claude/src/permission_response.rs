use std::rc::{Rc, Weak};

use garcon_agents_common::execution::{
    permission_modes::is_manual_bypass_mode,
    runtime_events::{AgentRuntimeEvent, RuntimePermissionResponse},
};
use garcon_base::errors::NamedError;
use garcon_contract::chat_command_contracts::{
    PermissionDecisionPayload, PermissionDecisionResponse,
};
use garcon_interface::{
    producer::{AgentProviderPermissionLifecycle, AgentTerminalPermission},
    resources::ExecutorResult,
};
use garcon_js::{json::Opaque, trim};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::{
    claude_cli::ClaudeCli,
    permission_tool_converter::convert_claude_permission_request,
    runtime_state::{ClaudeRunningSession, PendingPermission},
};

pub struct ClaudePermissionInput<'a> {
    pub tool_name: Option<&'a str>,
    pub tool_input: Option<&'a Value>,
    pub tool_use_id: Option<&'a str>,
    pub provider_tool_name: Option<&'a str>,
    pub provider_tool_input: Option<&'a Value>,
}

pub struct ClaudePermissionDecision<'a> {
    pub allow: bool,
    pub always_allow: bool,
    pub response: Option<&'a Value>,
}

pub fn is_claude_ask_user_question_tool(tool: Option<&str>) -> bool {
    tool.unwrap_or_default()
        .to_lowercase()
        .chars()
        .filter(|&ch| !matches!(ch, '_' | '-') && !trim(ch.encode_utf8(&mut [0; 4])).is_empty())
        .eq("askuserquestion".chars())
}

pub fn build_claude_permission_approval_response(
    pending: ClaudePermissionInput<'_>,
    decision: ClaudePermissionDecision<'_>,
) -> Result<Opaque, NamedError> {
    let default_input = Value::Object(Map::new());
    let input = pending
        .provider_tool_input
        .or(pending.tool_input)
        .unwrap_or(&default_input);
    let name = pending
        .provider_tool_name
        .or(pending.tool_name)
        .unwrap_or("Unknown");
    let tool_use_id = pending.tool_use_id.filter(|id| !id.is_empty());
    if let Some(response) = decision.response {
        if is_claude_ask_user_question_tool(Some(name))
            && response["type"] == "ask-user-question-response"
        {
            match response["outcome"].as_str() {
                Some("answered") if decision.allow => {
                    return allow_questions(input, response, tool_use_id).map(Opaque::from_value);
                }
                Some("skipped" | "answered") => {
                    let reason = response.get("reason").filter(|value| !value.is_null());
                    let mut result = json!({
                        "behavior":"deny",
                        "message":reason.unwrap_or(&Value::String("User declined to answer questions".into())),
                    });
                    if let Some(tool_use_id) = tool_use_id {
                        result["toolUseID"] = json!(tool_use_id);
                    }
                    return Ok(result.into());
                }
                _ => {}
            }
        }
        return Ok(response.clone().into());
    }
    if !decision.allow {
        return Ok(json!({"behavior":"deny", "message":"Denied by user"}).into());
    }
    let mut response = json!({"behavior":"allow", "updatedInput":input});
    if decision.always_allow {
        response["updatedPermissions"] = json!([{
            "type":"addRules", "rules":[{"toolName":name}],
            "behavior":"allow", "destination":"session",
        }]);
    }
    Ok(response.into())
}

fn type_error(message: impl Into<String>) -> NamedError {
    NamedError {
        name: "TypeError".into(),
        message: message.into(),
        code: None,
    }
}

fn allow_questions(
    input: &Value,
    response: &Value,
    tool_use_id: Option<&str>,
) -> Result<Value, NamedError> {
    let questions = input["questions"].as_array().map_or(&[][..], Vec::as_slice);
    let mut answers = Map::new();
    let mut annotations = Map::new();
    let answers_value = response.get("answers");
    let answer_list = answers_value.and_then(Value::as_array).ok_or_else(|| {
        type_error(match answers_value {
            None => "undefined is not an object (evaluating 'answer of decision.response.answers')",
            Some(Value::Null) => {
                "null is not an object (evaluating 'answer of decision.response.answers')"
            }
            _ => "decision.response.answers is not iterable",
        })
    })?;
    for answer in answer_list {
        if answer.is_null() {
            return Err(type_error(
                "null is not an object (evaluating 'answer.questionId')",
            ));
        }
        let id = &answer["questionId"];
        let question = questions
            .iter()
            .find(|question| question["question"] == *id);
        let text = question
            .and_then(|question| question["question"].as_str())
            .or_else(|| id.as_str())
            .unwrap_or_default();
        let options = question
            .and_then(|question| question["options"].as_array())
            .map_or(&[][..], Vec::as_slice);
        let first_match = |option_id: &Value| {
            options
                .iter()
                .find(|option| option["label"] == *option_id || option["id"] == *option_id)
        };
        let selected = answer.get("selectedOptionIds");
        let selected_ids = selected.and_then(Value::as_array).ok_or_else(|| {
            type_error(match selected {
                None => "undefined is not an object (evaluating 'answer.selectedOptionIds.map')",
                Some(Value::Null) => {
                    "null is not an object (evaluating 'answer.selectedOptionIds.map')"
                }
                _ => "answer.selectedOptionIds.map is not a function",
            })
        })?;
        let labels: Vec<_> = selected_ids
            .iter()
            .filter_map(|id| {
                first_match(id)
                    .and_then(|option| option["label"].as_str())
                    .or_else(|| id.as_str())
            })
            .collect();
        answers.insert(text.to_owned(), json!(labels.join(", ")));
        if let Some(preview) = selected_ids
            .first()
            .and_then(first_match)
            .and_then(|option| option["preview"].as_str())
        {
            annotations.insert(text.to_owned(), json!({"preview":preview}));
        }
    }
    let mut updated_input = input.as_object().cloned().unwrap_or_default();
    updated_input.insert("answers".into(), Value::Object(answers));
    if !annotations.is_empty() {
        updated_input.insert("annotations".into(), Value::Object(annotations));
    }
    let mut response = json!({"behavior":"allow", "updatedInput":updated_input});
    if let Some(tool_use_id) = tool_use_id {
        response["toolUseID"] = json!(tool_use_id);
    }
    Ok(response)
}

fn control_response(request_id: Option<&str>, response: Value) -> String {
    let mut body = Map::new();
    if let Some(id) = request_id {
        body.insert("request_id".into(), json!(id));
    }
    if let Value::Object(response) = response {
        body.extend(response);
    }
    garcon_js::json::stringify(&json!({"type":"control_response", "response":body}))
}

struct ClaudePermissionResponder {
    runtime: Weak<ClaudeCli>,
    occurrence_id: String,
}

#[async_trait::async_trait(?Send)]
impl RuntimePermissionResponse for ClaudePermissionResponder {
    fn permission_occurrence_id(&self) -> &str {
        &self.occurrence_id
    }

    async fn respond(&self, decision: PermissionDecisionPayload) -> ExecutorResult<()> {
        const NOT_PENDING: &str = "Claude permission occurrence is no longer pending";
        let runtime = self.runtime.upgrade().ok_or(NOT_PENDING)?;
        let (session_id, frame) = {
            let permissions = runtime.pending_permissions.borrow();
            let pending = permissions
                .iter()
                .find(|pending| pending.permission_occurrence_id == self.occurrence_id)
                .ok_or(NOT_PENDING)?;
            let response = match decision.response {
                Some(PermissionDecisionResponse::Provider(response)) => Some(response.into_value()),
                Some(PermissionDecisionResponse::Structured(response)) => {
                    Some(serde_json::to_value(response)?)
                }
                None => None,
            };
            let response = build_claude_permission_approval_response(
                ClaudePermissionInput {
                    tool_name: Some(&pending.tool_name),
                    tool_input: Some(pending.tool_input.as_value()),
                    tool_use_id: pending.tool_use_id.as_deref(),
                    provider_tool_name: None,
                    provider_tool_input: None,
                },
                ClaudePermissionDecision {
                    allow: decision.allow,
                    always_allow: decision.always_allow.unwrap_or_default(),
                    response: response.as_ref(),
                },
            )?;
            (
                pending.agent_session_id.clone(),
                control_response(
                    pending.cli_request_id.as_deref(),
                    json!({"subtype":"success", "response":response.into_value()}),
                ),
            )
        };
        let process = runtime
            .session(&session_id)
            .and_then(|session| session.process.borrow().clone())
            .ok_or_else(|| format!("Claude session {session_id} has no writable process"))?;
        process
            .transport
            .write_line(frame, Default::default())
            .await?;
        runtime
            .pending_permissions
            .borrow_mut()
            .retain(|pending| pending.permission_occurrence_id != self.occurrence_id);
        Ok(())
    }
}

impl ClaudeCli {
    pub(crate) fn handle_permission_control_request(
        self: &Rc<Self>,
        session: &ClaudeRunningSession,
        message: &Value,
    ) {
        let request = &message["request"];
        let request_id = message["request_id"].as_str();
        let subtype = request["subtype"]
            .as_str()
            .filter(|subtype| !subtype.is_empty())
            .unwrap_or("missing");
        if subtype != "can_use_tool" {
            self.try_send_permission_response(session, request_id, json!({
                "subtype":"error", "error":format!("Unsupported control request subtype: {subtype}")
            }));
            return;
        }
        let turn = session.active_turn.borrow().clone();
        let Some(turn) = turn.filter(|turn| turn.protocol.borrow().input_started()) else {
            self.log_dropped_permission(session, "missing active operation");
            self.try_send_permission_response(session, request_id, json!({
                "subtype":"error", "error":"Claude tool permission arrived outside the active Garcon turn"
            }));
            return;
        };
        let occurrence_id = uuid::Uuid::new_v4().to_string();
        let name = request["tool_name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or("Unknown");
        let empty = json!({});
        let input = request
            .get("input")
            .filter(|input| match input {
                Value::Null => false,
                Value::Bool(value) => *value,
                Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
                Value::String(value) => !value.is_empty(),
                _ => true,
            })
            .unwrap_or(&empty);
        let tool_use_id = request["tool_use_id"].as_str();
        if is_manual_bypass_mode(Some(session.current_permission_mode.get()))
            && !is_claude_ask_user_question_tool(Some(name))
        {
            let response = build_claude_permission_approval_response(
                ClaudePermissionInput {
                    tool_name: Some(name),
                    tool_input: Some(input),
                    tool_use_id,
                    provider_tool_name: None,
                    provider_tool_input: None,
                },
                ClaudePermissionDecision {
                    allow: true,
                    always_allow: false,
                    response: None,
                },
            );
            // INFALLIBLE: Only a structured question decision can fail; no response was supplied.
            let response = response.expect("unstructured approval cannot inspect question answers");
            self.try_send_permission_response(
                session,
                request_id,
                json!({"subtype":"success", "response":response.into_value()}),
            );
            return;
        }

        let timestamp = match session.now_iso() {
            Ok(timestamp) => timestamp,
            Err(error) => {
                self.try_send_permission_response(
                    session,
                    request_id,
                    json!({"subtype":"error", "error":error.to_string()}),
                );
                return;
            }
        };
        self.pending_permissions
            .borrow_mut()
            .push(PendingPermission {
                permission_occurrence_id: occurrence_id.clone(),
                cli_request_id: request_id.map(str::to_owned),
                agent_session_id: session.id.clone(),
                tool_name: name.to_owned(),
                tool_input: input.clone().into(),
                tool_use_id: tool_use_id.map(str::to_owned),
                turn: turn.clone(),
            });
        let lifecycle = AgentProviderPermissionLifecycle::Requested(
            convert_claude_permission_request(&timestamp, &occurrence_id, request),
        );
        self.publisher.event(
            &session.id,
            &turn,
            AgentRuntimeEvent::Permission {
                run_id: turn.operation.run_id.clone(),
                lifecycle,
                decision: Some(Rc::new(ClaudePermissionResponder {
                    runtime: Rc::downgrade(self),
                    occurrence_id,
                })),
            },
        );
    }

    pub(crate) fn handle_permission_control_cancel(
        &self,
        session: &ClaudeRunningSession,
        message: &Value,
    ) {
        if let Some(request_id) = message["request_id"].as_str().filter(|id| !id.is_empty()) {
            let pending = self
                .pending_permissions
                .borrow_mut()
                .extract_if(.., |pending| {
                    pending.agent_session_id == session.id
                        && pending.cli_request_id.as_deref() == Some(request_id)
                })
                .next();
            if let Some(pending) = pending {
                self.publisher.event(
                    &session.id,
                    &pending.turn,
                    AgentRuntimeEvent::Permission {
                        run_id: pending.turn.operation.run_id.clone(),
                        lifecycle: AgentProviderPermissionLifecycle::Terminal(
                            AgentTerminalPermission::Cancelled {
                                permission_occurrence_id: pending.permission_occurrence_id,
                                reason: Some("cancelled".into()),
                            },
                        ),
                        decision: None,
                    },
                );
                return;
            }
        }
        self.log_dropped_permission(session, "missing permission occurrence");
    }

    fn log_dropped_permission(&self, session: &ClaudeRunningSession, reason: &str) {
        self.logger.warn(
            "Dropped an unnamed Claude permission event",
            Some(&IndexMap::from_iter([
                ("chatId".into(), json!(session.chat_id).into()),
                ("eventType".into(), json!("permission").into()),
                ("reason".into(), json!(reason).into()),
            ])),
        );
    }

    fn try_send_permission_response(
        &self,
        session: &ClaudeRunningSession,
        request_id: Option<&str>,
        response: Value,
    ) {
        let process = session.process.borrow().clone();
        let session_id = session.id.clone();
        let frame = control_response(request_id, response);
        let logger = self.logger.clone();
        let written =
            process.map(|process| process.transport.write_line(frame, Default::default()));
        tokio::task::spawn_local(async move {
            let result = match written {
                Some(written) => written.await,
                None => Err(format!("Claude session {session_id} has no writable process").into()),
            };
            if let Err(error) = result {
                let prefix = String::from_utf16_lossy(
                    &session_id.encode_utf16().take(8).collect::<Vec<_>>(),
                );
                logger.warn(
                    "Claude CLI stdin write failed",
                    Some(&IndexMap::from_iter([
                        ("sessionId".into(), json!(prefix).into()),
                        ("error".into(), json!(error.to_string()).into()),
                    ])),
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text, unknown};

    use super::*;

    #[test]
    fn recorded_permission_control_responses_match() {
        replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/permission-response"
            ),
            |function, args| match function {
                "isClaudeAskUserQuestionTool" => {
                    let value = text(function, args.first())?;
                    Ok(json!(is_claude_ask_user_question_tool(value)))
                }
                "buildClaudePermissionApprovalResponse" => {
                    let pending = unknown(function, args.first())?;
                    let decision = unknown(function, args.get(1))?;
                    let result = build_claude_permission_approval_response(
                        ClaudePermissionInput {
                            tool_name: pending["toolName"].as_str(),
                            tool_input: pending.get("toolInput").filter(|input| !input.is_null()),
                            tool_use_id: pending["toolUseId"].as_str(),
                            provider_tool_name: pending["providerToolName"].as_str(),
                            provider_tool_input: pending
                                .get("providerToolInput")
                                .filter(|input| !input.is_null()),
                        },
                        ClaudePermissionDecision {
                            allow: decision["allow"] == true,
                            always_allow: decision["alwaysAllow"] == true,
                            response: decision.get("response").filter(|input| !input.is_null()),
                        },
                    );
                    Ok(match result {
                        Ok(response) => response.into_value(),
                        Err(error) => {
                            json!({"$":"error", "name":error.name, "message":error.message, "properties":{}})
                        }
                    })
                }
                _ => Err(CaseError::unhandled(function)),
            },
        );
    }
}
