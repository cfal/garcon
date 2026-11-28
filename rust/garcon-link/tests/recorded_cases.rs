use garcon_base::domain_error::DomainError;
use garcon_cases::{CaseError, replay, round_tripped, text, unknown};
use garcon_link::connection_url::{
    ExecutorSocketUrlOptions, create_executor_secret, executor_connection_url, is_executor_secret,
    parse_connection_url, validate_executor_socket_url,
};
use garcon_link::failure_reason::{Failure, failure_reason};
use garcon_link::limits::*;
use garcon_link::message_queue_budget::{MessageQueueBudget, MessageQueueLimits};
use garcon_link::rpc_lane::{RpcLane, is_session_id, parse_bulk_control};
use serde::Serialize;
use serde_json::{Value, json};

fn validation<T: Serialize>(result: Result<T, DomainError>) -> Value {
    match result {
        Ok(value) => json!(value),
        Err(error) => json!({
            "$": "error",
            "name": error.kind.name(),
            "message": error.message,
            "properties": {
                "code": error.code.as_str(),
                "status": error.status,
                "retryable": error.retryable,
            }
        }),
    }
}

#[test]
fn recorded_connection_url_cases_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/transport/connection-url"
        ),
        |function, args| match function {
            "createExecutorSecret" => {
                let secret = json!(create_executor_secret());
                assert!(is_executor_secret(&secret));
                Ok(secret)
            }
            "parseConnectionUrl" => {
                let url = text(function, args.first())?.unwrap_or_default();
                Ok(validation(parse_connection_url(url)))
            }
            "validateExecutorSocketUrl" => {
                let url = text(function, args.first())?.unwrap_or_default();
                let options = round_tripped(function, args.get(1))?;
                let flag = |name: &str| {
                    options
                        .as_deref()
                        .and_then(|options| options.get(name))
                        .and_then(Value::as_bool)
                        .unwrap_or_default()
                };
                Ok(validation(validate_executor_socket_url(
                    url,
                    ExecutorSocketUrlOptions {
                        no_tls: flag("noTls"),
                        allow_placeholder: flag("allowPlaceholder"),
                    },
                )))
            }
            "executorConnectionUrl" => {
                let url = text(function, args.first())?.unwrap_or_default();
                let secret = text(function, args.get(1))?.unwrap_or_default();
                Ok(match executor_connection_url(url, secret) {
                    Ok(value) => json!(value),
                    Err(error) => json!({
                        "$": "error",
                        "name": "TypeError",
                        "message": error.to_string(),
                        "properties": { "code": "ERR_INVALID_URL", "input": error.input },
                    }),
                })
            }
            "isExecutorSecret" => Ok(json!(is_executor_secret(
                unknown(function, args.first())?.as_ref()
            ))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn recorded_failure_reason_cases_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/transport/failure-reason"
        ),
        |function, args| {
            if function != "reasonWithStack" {
                return Err(CaseError::unhandled(function));
            }
            let kind = text(function, args.first())?.unwrap_or_default();
            let message = text(function, args.get(1))?.unwrap_or_default();
            let stack = text(function, args.get(2))?;
            let header = if message.is_empty() {
                "SyntaxError".to_owned()
            } else {
                format!("SyntaxError: {message}")
            };
            let failure = if kind == "syntax" {
                Failure::SyntaxError {
                    header: &header,
                    stack,
                }
            } else {
                Failure::Text(message)
            };
            Ok(json!(failure_reason(failure)))
        },
    );
}

#[test]
fn recorded_rpc_lane_cases_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/transport/rpc-lane"
        ),
        |function, args| {
            let value = unknown(function, args.first())?;
            match function {
                "isSessionId" => Ok(json!(is_session_id(&value))),
                "parseBulkControl" => Ok(match parse_bulk_control(&value) {
                    Ok(control) => {
                        let wire = serde_json::to_string(&control).unwrap();
                        garcon_js::json::parse(&wire).unwrap()
                    }
                    Err(error) => json!({
                        "$": "error", "name": "Error", "message": error.to_string(), "properties": {}
                    }),
                }),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

#[tokio::test]
async fn recorded_queue_and_limits_cases_match() {
    tokio::task::LocalSet::new()
        .run_until(async {
            replay(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/cases/transport/queue-and-limits"
                ),
                |function, _| match function {
                    "transportLimits" => Ok(json!({
                        "EXECUTOR_RECONNECT_GRACE_MS": EXECUTOR_RECONNECT_GRACE_MS,
                        "RPC_CALL_LIMIT": RPC_CALL_LIMIT,
                        "BULK_RPC_CALL_LIMIT": BULK_RPC_CALL_LIMIT,
                        "RPC_INSTALLATION_CALL_LIMIT": RPC_INSTALLATION_CALL_LIMIT,
                        "RPC_QUEUE_BYTES": RPC_QUEUE_BYTES,
                        "RPC_QUEUE_MESSAGES": RPC_QUEUE_MESSAGES,
                        "BULK_QUEUE_BYTES": BULK_QUEUE_BYTES,
                        "BULK_QUEUE_MESSAGES": BULK_QUEUE_MESSAGES,
                        "BULK_CONTROL_BYTES": BULK_CONTROL_BYTES,
                        "BULK_CONTROL_RESERVE_BYTES": BULK_CONTROL_RESERVE_BYTES,
                        "BULK_CONTROL_RESERVE_MESSAGES": BULK_CONTROL_RESERVE_MESSAGES,
                        "PRIMARY_SMALL_RPC_BYTES": PRIMARY_SMALL_RPC_BYTES,
                        "BULK_ACQUIRE_TIMEOUT_MS": BULK_ACQUIRE_TIMEOUT_MS,
                        "BULK_SETUP_TIMEOUT_MS": BULK_SETUP_TIMEOUT_MS,
                        "RPC_JOURNAL_BYTES": RPC_JOURNAL_BYTES,
                        "BULK_JOURNAL_BYTES": BULK_JOURNAL_BYTES,
                    })),
                    "queueBudget" => Ok(queue_budget()),
                    _ => Err(CaseError::unhandled(function)),
                },
            );
        })
        .await;
}

fn queue_budget() -> Value {
    let budget = MessageQueueBudget::new(MessageQueueLimits {
        bytes: 1000,
        messages: 8,
        bulk_bytes: 600,
        bulk_messages: 4,
        control_bytes: 200,
        control_messages: 2,
    });
    let bulk = budget.reserve(RpcLane::Bulk, 600).unwrap();
    let primary = budget.reserve(RpcLane::Primary, 200).unwrap();
    let control = budget.reserve_control(100).unwrap();
    let second = budget.reserve_control(100).unwrap();
    let admits = |control_bytes| {
        [
            budget.can_admit(RpcLane::Bulk, 1),
            budget.can_admit(RpcLane::Primary, 1),
            budget.can_admit_control(control_bytes),
        ]
    };
    let full = admits(1);
    let counts = [budget.queued_bytes(), budget.queued_messages()];
    bulk.release();
    bulk.release();
    let freed = admits(0);
    primary.release();
    control.release();
    second.release();
    json!({ "full": full, "counts": counts, "freed": freed, "final": budget.snapshot() })
}
