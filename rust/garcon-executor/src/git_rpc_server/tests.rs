use garcon_js::json::Opaque;
use serde_json::json;
use tokio::task::LocalSet;

use crate::worker::{Executor, ExecutorOptions};

use super::*;

fn call(method: &str, request: Value) -> ExecutorRpcRequest {
    ExecutorRpcRequest {
        id: "synthetic-call".into(),
        seq: 1,
        integration_id: String::new(),
        method: method.into(),
        request: Opaque::from_value(request),
    }
}

fn assert_invalid(error: &SessionError, message: &str) {
    let error = error.downcast_ref::<GitServiceError>().unwrap();
    assert_eq!(error.code, GitServiceErrorCode::GIT_INVALID_INPUT);
    assert_eq!(error.message, message);
}

#[tokio::test]
async fn dispatches_git_against_the_selected_executor_and_keeps_the_wire_scope() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let status = tokio::process::Command::new("git")
                .args(["init", "-q", "-b", "fixture"])
                .current_dir(&root)
                .status()
                .await
                .unwrap();
            assert!(status.success());
            tokio::fs::write(root.path().join("untracked.txt"), b"synthetic")
                .await
                .unwrap();
            let path = root.path().to_str().unwrap();
            let executor = Executor::start(ExecutorOptions {
                executor_id: "local".into(),
                project_base_path: path.into(),
                terminal_runtime_id: None,
                user_shell: None,
                child_environment: None,
                integrations: None,
            })
            .unwrap();
            let api = executor.api();
            let info = api.get_info(None).await.unwrap();
            let server = GitRpcServer::new(api);
            let result = server
                .handle(
                    &call(
                        "git.getStatus",
                        json!({"input":{"projectPath":path},"budgetMs":GIT_OPERATION_TIMEOUT_MS}),
                    ),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result["branch"], "fixture");
            assert_eq!(result["untracked"], json!(["untracked.txt"]));
            assert_eq!(result["executorId"], info.executor_id);
            assert_eq!(result["instanceId"], info.instance_id);
            let refs = server
                .handle(
                    &call(
                        "git.getRefs",
                        json!({"input":{"projectPath":path,"limit":1.0},"budgetMs":GIT_OPERATION_TIMEOUT_MS}),
                    ),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(refs["executorId"], info.executor_id);
        })
        .await;
}

#[tokio::test]
async fn validates_the_deadline_before_the_operation_and_uses_the_github_detail_limit() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let executor = Executor::start(ExecutorOptions {
                executor_id: "local".into(),
                project_base_path: root.path().to_str().unwrap().into(),
                terminal_runtime_id: None,
                user_shell: None,
                child_environment: None,
                integrations: None,
            })
            .unwrap();
            let server = GitRpcServer::new(executor.api());
            for input in [
                json!({}),
                json!({"input":[],"budgetMs":10}),
                json!({"input":{},"budgetMs":0}),
                json!({"input":{},"budgetMs":1.5}),
                json!({"input":{},"budgetMs":"10"}),
                json!({"input":{},"budgetMs":10,"extra":true}),
                json!({"input":{},"budgetMs":GIT_OPERATION_TIMEOUT_MS+1}),
            ] {
                let error = server
                    .handle(&call("git.getStatus", input), CancellationToken::new())
                    .await
                    .unwrap_err();
                assert_invalid(&error, "Invalid Git operation deadline");
            }
            let request = json!({"input":{},"budgetMs":1});
            let invalid_input = server
                .handle(
                    &call("git.getStatus", request.clone()),
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_invalid(&invalid_input, "Invalid Git getStatus request");
            let unknown = server
                .handle(&call("git.future", request), CancellationToken::new())
                .await
                .unwrap_err();
            assert_invalid(&unknown, "Unsupported Git operation");
            let github_limit = gh_operation_timeout_ms(GhMethod::GetPullRequest);
            let beyond = server
                .handle(
                    &call(
                        "gh.getPullRequest",
                        json!({"input":{},"budgetMs":github_limit+1}),
                    ),
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_invalid(&beyond, "Invalid Git operation deadline");
            let at_limit = server
                .handle(
                    &call(
                        "gh.getPullRequest",
                        json!({"input":{},"budgetMs":github_limit}),
                    ),
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(
                at_limit.to_string(),
                "Executor GitHub service is not ported yet"
            );
        })
        .await;
}

#[test]
fn records_deadline_and_input_rejections_against_the_original() {
    use garcon_base::errors::error_metadata;
    use garcon_cases::{CaseError, replay, round_tripped, unknown};

    let driver = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let root = tempfile::tempdir().unwrap();
    let executor = local.block_on(&driver, async {
        Executor::start(ExecutorOptions {
            executor_id: "local".into(),
            project_base_path: root.path().to_str().unwrap().into(),
            terminal_runtime_id: None,
            user_shell: None,
            child_environment: None,
            integrations: None,
        })
        .unwrap()
    });
    let server = GitRpcServer::new(executor.api());
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/git-rpc-server"),
        |function, args| {
            if function != "rejectedGitRpc" {
                return Err(CaseError::unhandled(function));
            }
            let method = round_tripped(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing method"))?;
            let method = method
                .as_str()
                .ok_or_else(|| CaseError::undeliverable("method must be text"))?;
            let request = unknown(function, args.get(1))?.into_owned();
            let result = local.block_on(
                &driver,
                server.handle(&call(method, request), CancellationToken::new()),
            );
            let error = result
                .err()
                .ok_or_else(|| CaseError::undeliverable("invalid input reached Git"))?;
            let git = error
                .downcast_ref::<GitServiceError>()
                .ok_or_else(|| CaseError::undeliverable(error.to_string()))?;
            Ok(
                json!({"name":error_metadata(error.as_ref()).name,"code":git.code,"message":git.message,"status":git.status}),
            )
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
