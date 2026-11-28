use std::rc::Rc;

use garcon_agents_common::execution::runtime_events::{
    AgentRuntimeEvent, AgentRuntimePublisher, ProviderRunOutcome, RuntimePermissionResponse,
    runtime_rows,
};
use garcon_base::errors::NamedError;
use garcon_contract::chat_types::{
    ChatMessage, PermissionCancelledMessage, PermissionExpiredMessage, PermissionRequestMessage,
};
use garcon_interface::{
    host::AgentLogger,
    native_message_source::NativeSourced,
    producer::{
        AgentFinalResponse, AgentProviderPermissionLifecycle, AgentRequestedPermission,
        AgentRunFailureDetail, AgentTerminalPermission,
    },
    resources::ExecutorResult,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::json;

pub struct CodexOperation {
    pub chat_id: String,
    pub run_id: String,
    pub publish: AgentRuntimePublisher,
}

pub fn codex_operation(
    chat_id: &str,
    run_id: &str,
    publish: AgentRuntimePublisher,
) -> Rc<CodexOperation> {
    Rc::new(CodexOperation {
        chat_id: chat_id.into(),
        run_id: run_id.into(),
        publish,
    })
}

pub fn publish_rows(
    logger: &dyn AgentLogger,
    chat_id: &str,
    messages: Vec<NativeSourced<ChatMessage>>,
    operation: Option<&CodexOperation>,
) {
    if !messages.is_empty() {
        publish(logger, chat_id, operation, "rows", |_| {
            AgentRuntimeEvent::Rows {
                rows: runtime_rows(messages),
            }
        });
    }
}

pub fn publish_permission_requested(
    logger: &dyn AgentLogger,
    chat_id: &str,
    message: PermissionRequestMessage,
    decision: Rc<dyn RuntimePermissionResponse>,
    operation: Option<&CodexOperation>,
) -> ExecutorResult<()> {
    if decision.permission_occurrence_id() != message.permission_occurrence_id {
        return Err(Box::new(NamedError {
            name: "TypeError".into(),
            code: None,
            message: "Permission response capability does not match its request occurrence".into(),
        }));
    }
    publish(logger, chat_id, operation, "permission", |run_id| {
        AgentRuntimeEvent::Permission {
            run_id: run_id.into(),
            lifecycle: AgentProviderPermissionLifecycle::Requested(
                AgentRequestedPermission::Requested {
                    permission_occurrence_id: message.permission_occurrence_id,
                    requested_tool: Box::new(message.requested_tool),
                    options: Vec::new(),
                    reason: None,
                },
            ),
            decision: Some(decision),
        }
    });
    Ok(())
}

pub fn publish_permission_cancelled(
    logger: &dyn AgentLogger,
    chat_id: &str,
    message: PermissionCancelledMessage,
    operation: Option<&CodexOperation>,
) {
    publish_terminal_permission(
        logger,
        chat_id,
        operation,
        AgentTerminalPermission::Cancelled {
            permission_occurrence_id: message.permission_occurrence_id,
            reason: message
                .reason
                .as_ref()
                .and_then(|reason| reason.as_str())
                .map(str::to_owned),
        },
    );
}

pub fn publish_permission_expired(
    logger: &dyn AgentLogger,
    chat_id: &str,
    message: PermissionExpiredMessage,
    operation: Option<&CodexOperation>,
) {
    publish_terminal_permission(
        logger,
        chat_id,
        operation,
        AgentTerminalPermission::Expired {
            permission_occurrence_id: message.permission_occurrence_id,
        },
    );
}

fn publish_terminal_permission(
    logger: &dyn AgentLogger,
    chat_id: &str,
    operation: Option<&CodexOperation>,
    terminal: AgentTerminalPermission,
) {
    publish(logger, chat_id, operation, "permission", |run_id| {
        AgentRuntimeEvent::Permission {
            run_id: run_id.into(),
            lifecycle: AgentProviderPermissionLifecycle::Terminal(terminal),
            decision: None,
        }
    });
}

pub fn publish_finished(
    logger: &dyn AgentLogger,
    chat_id: &str,
    operation: Option<&CodexOperation>,
    final_response: Option<AgentFinalResponse>,
) {
    publish(logger, chat_id, operation, "run-ended", |run_id| {
        AgentRuntimeEvent::RunEnded {
            run_id: run_id.into(),
            outcome: ProviderRunOutcome::Finished { final_response },
            working_directory: None,
        }
    });
}

pub fn publish_failed(
    logger: &dyn AgentLogger,
    chat_id: &str,
    message: String,
    operation: Option<&CodexOperation>,
) {
    publish(logger, chat_id, operation, "run-ended", |run_id| {
        AgentRuntimeEvent::RunEnded {
            run_id: run_id.into(),
            outcome: ProviderRunOutcome::Failed {
                error: Some(AgentRunFailureDetail {
                    code: "PROVIDER_FAILURE".into(),
                    message: Some(message),
                }),
            },
            working_directory: None,
        }
    });
}

fn publish(
    logger: &dyn AgentLogger,
    chat_id: &str,
    operation: Option<&CodexOperation>,
    event_type: &str,
    build: impl FnOnce(&str) -> AgentRuntimeEvent,
) {
    let Some(owned) = operation.filter(|operation| operation.chat_id == chat_id) else {
        logger.warn(
            "Dropped a Codex provider event with no owning operation",
            Some(&IndexMap::from([
                ("chatId".into(), Opaque::from_value(json!(chat_id))),
                (
                    "runId".into(),
                    Opaque::from_value(json!(operation.map(|op| &op.run_id))),
                ),
                ("eventType".into(), Opaque::from_value(json!(event_type))),
            ])),
        );
        return;
    };
    (owned.publish)(build(&owned.run_id));
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use garcon_contract::{
        chat_command_contracts::PermissionDecisionPayload, chat_types::ToolUseChatMessage,
    };

    use super::*;
    use crate::app_server::runtime_support::NoopLogger;

    #[derive(Default)]
    struct Logger(RefCell<Vec<(String, IndexMap<String, Opaque>)>>);

    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>) {
            self.0
                .borrow_mut()
                .push((message.into(), fields.cloned().unwrap_or_default()));
        }
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    struct Decision(&'static str);

    #[async_trait::async_trait(?Send)]
    impl RuntimePermissionResponse for Decision {
        fn permission_occurrence_id(&self) -> &str {
            self.0
        }

        async fn respond(&self, _: PermissionDecisionPayload) -> ExecutorResult<()> {
            Ok(())
        }
    }

    #[test]
    fn resolves_terminal_events_only_through_the_captured_chat_operation() {
        let logger = Logger::default();
        let events = Rc::new(RefCell::new(Vec::new()));
        let old = codex_operation(
            "chat",
            "old-run",
            Rc::new({
                let events = events.clone();
                move |event| events.borrow_mut().push(event)
            }),
        );
        publish_failed(&logger, "chat", "synthetic failure".into(), Some(&old));
        publish_finished(&logger, "other", Some(&old), None);
        publish_finished(&logger, "chat", None, None);
        let events = events.borrow();
        let [
            AgentRuntimeEvent::RunEnded {
                run_id,
                outcome: ProviderRunOutcome::Failed { error: Some(error) },
                ..
            },
        ] = events.as_slice()
        else {
            panic!("only the captured operation may finish");
        };
        assert_eq!(run_id, "old-run");
        assert_eq!(error.code, "PROVIDER_FAILURE");
        assert_eq!(error.message.as_deref(), Some("synthetic failure"));
        let warnings = logger.0.borrow();
        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[0].1["chatId"].as_str(), Some("other"));
        assert_eq!(warnings[0].1["runId"].as_str(), Some("old-run"));
        assert_eq!(warnings[1].1["eventType"].as_str(), Some("run-ended"));
        assert!(warnings[1].1["runId"].is_null());
    }

    #[test]
    fn rejects_a_permission_response_from_another_occurrence_before_publication() {
        let occurrence = PermissionRequestMessage {
            timestamp: "at".into(),
            permission_occurrence_id: "first".into(),
            requested_tool: ToolUseChatMessage::Bash {
                timestamp: "at".into(),
                tool_id: "tool".into(),
                command: "pwd".into(),
                description: None,
            },
            reason: None,
        };
        let operation = codex_operation(
            "chat",
            "run",
            Rc::new(|_| panic!("mismatched decision published")),
        );
        let err = publish_permission_requested(
            &NoopLogger,
            "chat",
            occurrence,
            Rc::new(Decision("second")),
            Some(&operation),
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Permission response capability does not match its request occurrence"
        );
    }
}
