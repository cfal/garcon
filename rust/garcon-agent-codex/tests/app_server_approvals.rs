use garcon_agent_codex::app_server::{
    approvals::{
        CodexApprovalError, CodexPendingApproval, build_approval_message, build_approval_response,
        create_pending_approval, is_approval_request,
    },
    protocol::{JsonRpcId, JsonRpcServerRequest},
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, replay_with_options, text, unknown,
};
use garcon_js::{
    Number,
    clock::ManualClock,
    json::{Opaque, as_number},
};
use serde_json::{Value, json};

fn id(value: &Value) -> JsonRpcId {
    if let Some(id) = value.as_str() {
        JsonRpcId::String(id.into())
    } else {
        JsonRpcId::Number(Number(as_number(value).unwrap()))
    }
}

fn request(value: &Value) -> JsonRpcServerRequest {
    JsonRpcServerRequest {
        id: id(&value["id"]),
        method: value["method"].as_str().unwrap().into(),
        params: value.get("params").cloned().map(Opaque::from_value),
    }
}

fn pending(value: &Value) -> CodexPendingApproval {
    CodexPendingApproval {
        permission_occurrence_id: value["permissionOccurrenceId"].as_str().unwrap().into(),
        request_id: id(&value["requestId"]),
        chat_id: value["chatId"].as_str().unwrap().into(),
        method: value["method"].as_str().unwrap().into(),
        params: Opaque::from_value(value["params"].clone()),
    }
}

fn error_value(error: CodexApprovalError) -> Value {
    let name = if matches!(error, CodexApprovalError::Time(_)) {
        "RangeError"
    } else {
        "TypeError"
    };
    json!({"$":"error","name":name,"message":error.to_string(),"properties":{}})
}

#[test]
fn recorded_approval_messages_and_native_decisions_match() {
    let clock = ManualClock::new(1_793_577_600_000);
    replay_with_options(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/app-server-approvals"
        ),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "buildApprovalMessage",
                path: "$.result.requestedTool.questions[*]",
                reason: "Codex creates options last; the shared parser writes them before header",
            }],
            ..Default::default()
        },
        |function, args| {
            Ok(match function {
                "isApprovalRequest" => {
                    let value = unknown(function, args.first())?;
                    json!(is_approval_request(&request(&value)))
                }
                "createPendingApproval" => {
                    const OCCURRENCE: &str = "00000000-0000-4000-8000-000000000001";
                    let chat_id = text(function, args.first())?.unwrap();
                    let value = unknown(function, args.get(1))?;
                    let pending =
                        create_pending_approval(chat_id, &request(&value), || OCCURRENCE.into());
                    json!({
                        "permissionOccurrenceId": pending.permission_occurrence_id == OCCURRENCE,
                        "requestId": pending.request_id, "chatId": pending.chat_id,
                        "method": pending.method, "params": pending.params,
                    })
                }
                "buildApprovalMessage" => {
                    let value = unknown(function, args.first())?;
                    build_approval_message(&pending(&value), &clock)
                        .map_or_else(error_value, |message| json!(message))
                }
                "buildApprovalResponse" => {
                    let value = unknown(function, args.first())?;
                    let decision =
                        serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                            .unwrap();
                    build_approval_response(&pending(&value), &decision, &clock)
                        .map_or_else(error_value, |response| json!(response))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
