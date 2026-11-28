use std::cell::RefCell;

use garcon_base::errors::{ErrorInput, error_metadata};
use garcon_cases::{CaseError, replay, text};
use serde_json::{Value, json};

use crate::types::execution_error_input;

use super::*;

struct Fake<'a> {
    scenario: &'a str,
    calls: RefCell<Vec<Value>>,
}

impl AttachmentAgentCapabilities for Fake<'_> {
    fn assert_executor_ready(&self, executor: Option<&str>) -> ExecutionOperationResult<()> {
        self.calls.borrow_mut().push(json!(["ready", executor]));
        if self.scenario == "offline" {
            return Err("Executor unavailable".into());
        }
        Ok(())
    }

    fn model_supports_images(
        &self,
        input: ModelImageSupport<'_>,
    ) -> ExecutionOperationResult<bool> {
        self.calls.borrow_mut().push(json!([
            "model",
            input.executor_id,
            input.agent_id,
            input.model,
            input.api_provider_id,
            input.model_endpoint_id
        ]));
        if self.scenario.ends_with("-lookup-fails") {
            return Err("endpoint unassigned".into());
        }
        Ok(self.scenario != "endpoint-unsupported")
    }

    fn supports_images(&self, agent: &str, executor: Option<&str>) -> bool {
        self.calls
            .borrow_mut()
            .push(json!(["agent", agent, executor]));
        self.scenario != "native-unsupported" && !self.scenario.starts_with("endpoint-")
    }

    fn file_attachment_admission(
        &self,
        agent: &str,
        mime: &str,
        size: usize,
        executor: Option<&str>,
    ) -> FileAttachmentAdmission {
        self.calls
            .borrow_mut()
            .push(json!(["file", agent, mime, size, executor]));
        match self.scenario {
            "file-unsupported" => FileAttachmentAdmission::UnsupportedType,
            "file-too-large" | "file-too-large-unnamed" => FileAttachmentAdmission::TextTooLarge {
                max_bytes: Number(120_999.0),
            },
            _ => FileAttachmentAdmission::Accepted,
        }
    }
}

fn trace(scenario: &str, data: Option<&str>) -> Value {
    let agents = Fake {
        scenario,
        calls: RefCell::new(Vec::new()),
    };
    let endpoint = scenario.starts_with("endpoint-");
    let image = AgentCommandImage {
        data: "data:image/png;base64,AAAA".into(),
        name: Some("screen.png".into()),
        mime_type: Some(" IMAGE/PNG ".into()),
    };
    let file = AgentCommandImage {
        data: data.unwrap_or("data:text/csv;base64,YWJj").into(),
        name: (scenario != "file-too-large-unnamed").then(|| "table.csv".into()),
        mime_type: Some(" TEXT/CSV\u{a0}".into()),
    };
    let attachments = match scenario {
        "empty" => vec![],
        "missing-mime" => vec![
            image,
            AgentCommandImage {
                data: "x".into(),
                name: None,
                mime_type: None,
            },
        ],
        "mixed" => vec![file, image],
        scenario if scenario.starts_with("file-") => vec![file],
        _ => vec![image],
    };
    let error = match assert_attachments_supported(
        &agents,
        AttachmentSupportInput {
            executor_id: (endpoint || scenario == "offline").then_some("remote-1"),
            agent_id: "synthetic",
            model: (!matches!(scenario, "empty" | "missing-model")).then_some("model"),
            api_provider_id: endpoint.then_some("profile"),
            model_endpoint_id: endpoint.then_some("endpoint"),
            attachments: &attachments,
        },
    ) {
        Ok(()) => Value::Null,
        Err(error) => {
            let metadata = match execution_error_input(error.as_ref()) {
                ErrorInput::Diagnostic(error) => error.diagnostic_metadata(),
                _ => error_metadata(error.as_ref()),
            };
            match error.downcast_ref::<CommandValidationError>() {
                Some(error) => {
                    json!({"name": metadata.name, "message": error.message, "code": metadata.code, "status": error.status, "retryable": error.retryable})
                }
                None => json!({"name": metadata.name, "message": error.to_string()}),
            }
        }
    };
    json!({"error": error, "calls": agents.calls.into_inner()})
}

#[test]
fn attachment_admission_matches_bun() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/attachment-admission"
        ),
        |function, args| {
            if function != "attachmentAdmissionTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing scenario"))?;
            Ok(trace(scenario, text(function, args.get(1))?))
        },
    );
}
