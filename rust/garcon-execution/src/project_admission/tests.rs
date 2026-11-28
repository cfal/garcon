use std::cell::RefCell;

use garcon_base::domain_error::{DomainErrorKind, as_domain_error};
use garcon_cases::{CaseError, replay, text};
use garcon_contract::project_resolution::ProjectUnavailableReason;
use serde_json::{Value, json};

use super::*;

async fn trace(scenario: &str) -> Value {
    let current = RefCell::new((scenario != "missing").then(|| ProjectBinding {
        path: "/workspace/project".into(),
        epoch: "first".into(),
        executor_id: if scenario == "local-null" {
            OptionalNullable::NULL
        } else {
            OptionalNullable::some("11111111-1111-4111-8111-111111111111".into())
        },
    }));
    let calls = RefCell::new(Vec::new());
    let check = || {
        assert_available(
            || {
                current.borrow().as_ref().map(|chat| ProjectBinding {
                    path: chat.path.clone(),
                    executor_id: chat.executor_id.clone(),
                    epoch: chat.epoch.clone(),
                })
            },
            |path, executor, options| {
                let (calls, current) = (&calls, &current);
                async move {
                    calls.borrow_mut().push(json!([path, executor, {
                        "signal": options.signal.is_some(), "deadline": options.dispatch_deadline,
                        "timeout": options.timeout_ms,
                    }]));
                    tokio::task::yield_now().await;
                    if scenario == "failed" {
                        return Err("Synthetic inspection failure".into());
                    }
                    if scenario == "deleted" {
                        current.take();
                    }
                    if let Some(chat) = current.borrow_mut().as_mut() {
                        match scenario {
                            "path" => chat.path = "/other".into(),
                            "executor" => chat.executor_id = OptionalNullable::some("local".into()),
                            "owner" => chat.epoch = "replacement".into(),
                            "local-null" => chat.executor_id = OptionalNullable::ABSENT,
                            _ => {}
                        }
                    }
                    if matches!(scenario, "unavailable" | "owner") {
                        Ok(ProjectResolution::Unavailable {
                            reason: ProjectUnavailableReason::NotFound,
                        })
                    } else {
                        Ok(ProjectResolution::Available {
                            effective_project_key: "/real/project".into(),
                        })
                    }
                }
            },
            (scenario == "deadline").then_some(21_000.0),
            || 1000.0,
        )
    };
    let result = check().await;
    if scenario == "available" {
        check().await.unwrap();
    }
    let error = match result {
        Ok(()) => Value::Null,
        Err(error) => {
            if let Some(domain) = as_domain_error(error.as_ref()) {
                let mut fields = json!({"name": domain.kind.name(), "code": domain.code.as_str(),
                "message": domain.message, "status": domain.status, "retryable": domain.retryable});
                if let DomainErrorKind::ProjectUnavailable {
                    project_path,
                    reason,
                } = &domain.kind
                {
                    fields["projectPath"] = json!(project_path);
                    fields["reason"] = json!(reason);
                }
                fields
            } else {
                json!({"name": "Error", "message": error.to_string()})
            }
        }
    };
    json!({"error": error, "calls": calls.into_inner()})
}

#[test]
fn project_admission_matches_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/project-admission"),
        |function, args| {
            if function != "projectAdmissionTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing scenario"))?;
            Ok(runtime.block_on(trace(scenario)))
        },
    );
}
