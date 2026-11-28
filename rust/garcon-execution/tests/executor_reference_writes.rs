use std::{cell::RefCell, collections::HashMap, error::Error, path::Path, rc::Rc, time::Duration};

use garcon_base::domain_error::{DomainError, as_domain_error};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::error_codes::ErrorCode;
use garcon_execution::{
    reference_writes::{ExecutorReferenceWrites, ReleaseExecutorReferences},
    types::ExecutionOperationResult,
};
use serde_json::{Value, json};
use tokio::{sync::oneshot, task::LocalSet};

fn failure(error: &(dyn Error + 'static)) -> Value {
    let domain = as_domain_error(error);
    json!({
        "message":error.to_string(),
        "code":domain.map(|error|error.code.as_str()),
        "status":domain.map(|error|error.status),
        "retryable":domain.map(|error|error.retryable),
    })
}

fn executor_ids(value: &Value) -> Vec<Option<&str>> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(Value::as_str)
        .collect()
}

fn trace(steps: &Value) -> ExecutionOperationResult<Value> {
    let checks = Rc::new(RefCell::new(Vec::new()));
    let seen = checks.clone();
    let guard = ExecutorReferenceWrites::new(move |id| {
        seen.borrow_mut().push(id.to_owned());
        match id {
            "missing" => Err(std::io::Error::other("Missing executor").into()),
            "changing" => Err(DomainError::new(
                ErrorCode::EXECUTOR_IN_USE,
                "Executor is changing",
                409,
                true,
            )
            .into()),
            _ => Ok(()),
        }
    });
    let mut releases: HashMap<&str, ReleaseExecutorReferences> = HashMap::new();
    let mut outcomes = Vec::new();
    for step in steps
        .as_array()
        .ok_or_else(|| std::io::Error::other("expected reference write steps"))?
    {
        let id = step[1]
            .as_str()
            .ok_or_else(|| std::io::Error::other("expected executor or handle ID"))?;
        let result: ExecutionOperationResult<()> = match step[0].as_str() {
            Some("retain") => guard
                .retain(&executor_ids(&step[2]), &executor_ids(&step[3]))
                .map(|release| {
                    releases.insert(id, release);
                }),
            Some("assert") => guard.assert_no_writes(id).map_err(Into::into),
            Some("release") => {
                if let Some(release) = releases.remove(id) {
                    release();
                }
                Ok(())
            }
            _ => return Err(std::io::Error::other("unknown reference write step").into()),
        };
        outcomes.push(result.map_or_else(|error| failure(error.as_ref()), |()| Value::Null));
    }
    Ok(json!({"outcomes":outcomes,"checks":&*checks.borrow()}))
}

#[test]
fn executor_reference_writes_recordings() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/executor-reference-writes");
    replay(dir, |name, args| {
        if name != "referenceWritesTrace" {
            return Err(CaseError::unhandled(name));
        }
        trace(unknown(name, args.first())?.as_ref())
            .map_err(|error| CaseError::undeliverable(error.to_string()))
    });
}

#[test]
fn failed_new_reference_check_does_not_reserve_either_side() {
    let guard = ExecutorReferenceWrites::new(|id| {
        if id == "blocked" {
            Err(std::io::Error::other("unwritable").into())
        } else {
            Ok(())
        }
    });
    let failure = guard
        .retain(&[Some("new"), Some("blocked")], &[Some("old")])
        .err()
        .unwrap();
    assert_eq!(failure.to_string(), "unwritable");
    assert!(guard.assert_no_writes("new").is_ok());
    assert!(guard.assert_no_writes("old").is_ok());
}

#[tokio::test]
async fn both_sides_stay_retained_after_the_waiter_leaves_until_publication_finishes() {
    LocalSet::new()
        .run_until(async {
            let guard = Rc::new(ExecutorReferenceWrites::new(|id| {
                assert_eq!(id, "new", "only the added reference is revalidated");
                Ok(())
            }));
            let retain = guard.retention_callback();
            let release = retain(&[Some("new")], &[Some("old")]).unwrap();
            let (published, publication) = oneshot::channel();
            let (released, done) = oneshot::channel();
            let task = tokio::task::spawn_local(async move {
                publication.await.unwrap();
                drop(release);
                released.send(()).unwrap();
            });
            drop(task);
            for id in ["old", "new"] {
                assert_eq!(
                    guard.assert_no_writes(id).unwrap_err().code,
                    ErrorCode::EXECUTOR_IN_USE
                );
            }
            published.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), done)
                .await
                .unwrap()
                .unwrap();
            assert!(guard.assert_no_writes("old").is_ok());
            assert!(guard.assert_no_writes("new").is_ok());
        })
        .await;
}
