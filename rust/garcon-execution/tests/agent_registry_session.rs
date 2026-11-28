use std::{
    cell::{Cell, RefCell},
    path::Path,
    rc::Rc,
};

use garcon_cases::{CaseError, replay, text, unknown};
use garcon_execution::{
    execution_aborts::{ExecutionAbortDirectory, ExecutionAborts},
    execution_ownership::ExecutionAdmission,
    session_types::{
        PersistedChatExecutionConfig, assert_execution_admission_open,
        require_chat_execution_config,
    },
    types::{ExecutionOperationResult, LocalExecutionFuture},
};
use garcon_interface::{
    execution::AgentExecutionAdmission,
    execution_v5::{AgentExecutionHandle, AgentExecutionKind},
    resources::{AgentResourceRef, AgentResourceScope},
};
use garcon_js::OptionalNullable;
use serde_json::{Value, json};
use tokio::{sync::Notify, task::LocalSet};

fn session_config_trace(chat: &str, input: &Value) -> Value {
    let input = (!input.is_null()).then(|| PersistedChatExecutionConfig {
        executor_id: match input.get("executorId") {
            None => OptionalNullable::ABSENT,
            Some(value) => OptionalNullable::from(value.as_str().map(str::to_owned)),
        },
        project_path: input["projectPath"].as_str().map(str::to_owned),
        model: input["model"].as_str().map(str::to_owned),
        permission_mode: input["permissionMode"].as_str().map(str::to_owned),
        thinking_mode: input["thinkingMode"].as_str().map(str::to_owned),
        agent_settings_by_id: input.get("agentSettingsById").map(|settings| {
            garcon_js::json::from_str(&garcon_js::json::stringify(settings)).unwrap()
        }),
    });
    match require_chat_execution_config(chat, input.as_ref()) {
        Ok(config) => {
            garcon_js::json::from_str(&serde_json::to_string(&SessionTrace { config }).unwrap())
                .unwrap()
        }
        Err(error) => json!({"error":error.to_string()}),
    }
}

#[derive(serde::Serialize)]
struct SessionTrace {
    config: garcon_execution::session_types::RequiredChatExecutionConfig,
}

fn admission_trace(state: &str) -> Value {
    let admission = ExecutionAdmission::default();
    if state == "stopped" {
        admission.signal().cancel();
    }
    let result = assert_execution_admission_open((state != "absent").then_some(&admission), || {
        std::io::Error::other("Stopped before launch").into()
    });
    result.map_or_else(|error| json!(error.to_string()), |()| Value::Null)
}

struct AbortPorts {
    ready: RefCell<Vec<&'static str>>,
    effects: Rc<RefCell<Vec<Value>>>,
    reject_next: Cell<bool>,
    checked_ready: Notify,
}

impl ExecutionAbortDirectory for AbortPorts {
    fn is_ready(&self, executor: &str) -> bool {
        self.effects.borrow_mut().push(json!(["ready", executor]));
        self.checked_ready.notify_one();
        self.ready.borrow().contains(&executor)
    }

    fn abort(
        &self,
        agent: &str,
        handle: &AgentExecutionHandle,
    ) -> ExecutionOperationResult<LocalExecutionFuture<'static, bool>> {
        let scope = &handle.scope;
        self.effects
            .borrow_mut()
            .push(json!(["lookup", agent, scope.executor_id]));
        if !self.ready.borrow().contains(&scope.executor_id.as_str()) && !self.reject_next.get() {
            return Err(std::io::Error::other("offline").into());
        }
        let event = json!(["abort", scope.executor_id, scope.instance_id, handle.id]);
        let effects = self.effects.clone();
        let reject = self.reject_next.replace(false);
        Ok(Box::pin(async move {
            effects.borrow_mut().push(event);
            if reject {
                Err(std::io::Error::other("lost during abort").into())
            } else {
                Ok(true)
            }
        }))
    }
}

async fn abort_trace(mode: &str) -> Value {
    let ports = Rc::new(AbortPorts {
        ready: RefCell::default(),
        effects: Rc::default(),
        reject_next: Cell::new(mode == "async-rejection"),
        checked_ready: Notify::new(),
    });
    let aborts = Rc::new(ExecutionAborts::new(ports.clone()));
    let request = |chat, executor: &str, id: &str| {
        aborts.request(
            chat,
            "agent",
            &AgentResourceRef {
                scope: AgentResourceScope {
                    executor_id: executor.into(),
                    instance_id: "old-worker".into(),
                    integration_id: "agent".into(),
                },
                id: id.into(),
                kind: AgentExecutionKind::Execution,
            },
            "cleanup",
        )
    };
    match mode {
        "async-rejection" => {
            request("chat", "a", "one");
            ports.checked_ready.notified().await;
            ports.ready.borrow_mut().push("a");
            aborts.session_resumed("a");
        }
        "other-owner" | "replace" => {
            request("chat", "a", "one");
            request(
                if mode == "replace" {
                    "chat"
                } else {
                    "other-chat"
                },
                "b",
                "two",
            );
            ports.ready.borrow_mut().extend(["a", "b"]);
            aborts.session_resumed("unrelated");
            aborts.session_resumed("b");
            aborts.session_resumed("a");
        }
        "ready" => {
            ports.ready.borrow_mut().push("a");
            request("chat", "a", "one");
            aborts.session_resumed("a");
        }
        _ => panic!("undeliverable abort scenario {mode}"),
    }
    json!(&*ports.effects.borrow())
}

#[test]
fn agent_registry_session_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/agent-registry-session");
    replay(dir, |name, args| {
        let text = |index| {
            text(name, args.get(index))?.ok_or_else(|| CaseError::undeliverable("expected text"))
        };
        Ok(match name {
            "sessionConfigTrace" => {
                session_config_trace(text(0)?, unknown(name, args.get(1))?.as_ref())
            }
            "sessionAdmissionTrace" => admission_trace(text(0)?),
            "executionAbortsTrace" => {
                let mode = text(0)?;
                local.block_on(&runtime, async {
                    tokio::time::timeout(std::time::Duration::from_secs(2), abort_trace(mode))
                        .await
                        .map_err(|_| CaseError::undeliverable("abort trace did not finish"))
                })?
            }
            _ => return Err(CaseError::unhandled(name)),
        })
    });
}

#[test]
fn session_modes_are_normalized_only_after_required_fields_are_present() {
    let missing = session_config_trace("chat", &json!({"model":"","thinkingMode":"ultrathink"}));
    assert_eq!(missing, json!({"error":"Chat chat is missing projectPath"}));
    let config = session_config_trace(
        "chat",
        &json!({"projectPath":"/repo","model":"model","thinkingMode":"ultrathink","executorId":null}),
    );
    assert_eq!(config["config"]["thinkingMode"], "max");
    assert_eq!(config["config"]["executorId"], Value::Null);
    assert_eq!(admission_trace("stopped"), "Stopped before launch");
}

#[tokio::test]
async fn deferred_abort_targets_the_captured_worker_only() {
    let trace = LocalSet::new().run_until(abort_trace("other-owner")).await;
    assert_eq!(trace[4], json!(["lookup", "agent", "b"]));
    assert_eq!(trace[5], json!(["abort", "b", "old-worker", "two"]));
    assert_eq!(trace[6], json!(["lookup", "agent", "a"]));
    assert_eq!(trace[7], json!(["abort", "a", "old-worker", "one"]));
}
