use std::cell::Cell;
use std::process::Stdio;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::executor_disconnect::as_agent_call_error;
use garcon_contract::git::{
    GitCommitSnapshotOptions, GitCommitSnapshotResponse, GitReviewBodyPurpose,
    GitReviewDocumentFileBodiesResponse, GitReviewMode, GitWorkbenchSnapshotOptions,
    GitWorkbenchSnapshotResponse, ProjectOptions,
};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_contract::git_execution::{
    ExecutionGitReviewDocumentFileBodiesOptions, GitExecutorScope, GitReviewDocumentRef,
};
use garcon_interface::git::ExecutionGitService;
use garcon_js::{Number, OptionalNullable};
use serde_json::json;
use tokio::sync::{Barrier, oneshot};
use tokio::time::timeout;
use tokio::{io::AsyncWriteExt, process::Command, task::LocalSet};

use crate::ChildEnvironment;

use super::git_fixture::GitFixture;
use super::operation_context::track_git_process;
use super::runtime::{GitRuntime, GitRuntimeOptions};

async fn start_tracked_git(
    project: &str,
    started: oneshot::Sender<tokio::process::ChildStdin>,
    settled: Rc<Cell<bool>>,
) {
    let mut child = Command::new("git")
        .args(["hash-object", "--stdin"])
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    // The subprocess stays alive until the test closes its input.
    std::mem::drop(track_git_process(async move {
        assert!(child.wait().await?.success());
        settled.set(true);
        Ok(())
    }));
    assert!(started.send(input).is_ok());
}

#[tokio::test]
async fn dropping_a_mutation_reply_keeps_the_repository_locked_until_git_settles() {
    use garcon_contract::git::{GitMethod, GitMutationResult};

    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            let gateway = runtime(project, None);
            let request = ProjectOptions {
                project_path: project.into(),
            };
            let result = GitMutationResult {
                success: true,
                output: None,
                output_truncated: None,
                message: None,
                remote_name: None,
                remote_branch: None,
                worktree_path: None,
            };
            let (started, child) = oneshot::channel();
            let settled = Rc::new(Cell::new(false));
            let mut first =
                Box::pin(
                    gateway.invoke(GitMethod::InitialCommit, request.clone(), None, None, {
                        let settled = settled.clone();
                        let result = result.clone();
                        async move |_, request, _| {
                            start_tracked_git(&request.project_path, started, settled).await;
                            Ok(result)
                        }
                    }),
                );
            let input = tokio::select! {
                input = child => input.unwrap(),
                result = &mut first => panic!("reply finished before Git started: {result:?}"),
            };
            let mut second =
                Box::pin(
                    gateway.invoke(GitMethod::InitialCommit, request, None, None, {
                        let settled = settled.clone();
                        async move |_, _, _| {
                            assert!(
                                settled.get(),
                                "successor entered before its predecessor's Git process settled"
                            );
                            Ok(result)
                        }
                    }),
                );
            drop(first);
            assert!(
                timeout(Duration::from_millis(100), &mut second)
                    .await
                    .is_err()
            );
            assert!(!settled.get());
            drop(input);
            assert!(
                timeout(Duration::from_secs(5), second)
                    .await
                    .unwrap()
                    .unwrap()
                    .result
                    .success
            );
        })
        .await;
}

#[tokio::test]
async fn dropping_a_read_reply_keeps_its_admission_until_git_settles() {
    use garcon_contract::git::GitMethod;
    use garcon_contract::git_execution::GIT_MAX_CONCURRENT_QUERIES;

    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            let gateway = Rc::new(runtime(project, None));
            let request = ProjectOptions {
                project_path: project.into(),
            };
            let status = gateway
                .get_status(request.clone(), None)
                .await
                .unwrap()
                .result;
            let entered = Rc::new(Barrier::new(GIT_MAX_CONCURRENT_QUERIES));
            let release = Rc::new(Barrier::new(GIT_MAX_CONCURRENT_QUERIES));
            let holders: Vec<_> = (1..GIT_MAX_CONCURRENT_QUERIES)
                .map(|_| {
                    let (gateway, request, status, entered, release) = (
                        gateway.clone(),
                        request.clone(),
                        status.clone(),
                        entered.clone(),
                        release.clone(),
                    );
                    tokio::task::spawn_local(async move {
                        gateway
                            .invoke(
                                GitMethod::GetStatus,
                                request,
                                None,
                                None,
                                async move |_, _, _| {
                                    entered.wait().await;
                                    release.wait().await;
                                    Ok(status)
                                },
                            )
                            .await
                            .unwrap();
                    })
                })
                .collect();
            timeout(Duration::from_secs(5), entered.wait())
                .await
                .unwrap();
            let (started, child) = oneshot::channel();
            let settled = Rc::new(Cell::new(false));
            let mut held =
                Box::pin(
                    gateway.invoke(GitMethod::GetStatus, request.clone(), None, None, {
                        let settled = settled.clone();
                        async move |_, request, _| {
                            start_tracked_git(&request.project_path, started, settled).await;
                            Ok(status)
                        }
                    }),
                );
            let input = tokio::select! {
                input = child => input.unwrap(),
                result = &mut held => panic!("reply finished before Git started: {result:?}"),
            };
            drop(held);
            let rejected = gateway.get_status(request.clone(), None).await.unwrap_err();
            assert_eq!(
                rejected.downcast_ref::<GitServiceError>().unwrap().code,
                Code::GIT_SERVICE_BUSY
            );
            assert!(!settled.get());
            drop(input);
            release.wait().await;
            for holder in holders {
                holder.await.unwrap();
            }
            assert_eq!(
                gateway
                    .get_status(request, None)
                    .await
                    .unwrap()
                    .result
                    .branch,
                "main"
            );
        })
        .await;
}

fn runtime(project: &str, child_environment: Option<ChildEnvironment>) -> GitRuntime {
    GitRuntime::new(GitRuntimeOptions {
        scope: GitExecutorScope {
            executor_id: "local".into(),
            instance_id: "serving-test".into(),
        },
        project_base_path: project.into(),
        child_environment,
        review_registry: None,
        assert_available: None,
    })
}

#[tokio::test]
async fn rejects_foreign_documents_and_paths_and_preserves_typed_non_repository_fallbacks() {
    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        let project = repo.path().to_str().unwrap();
        let gateway = runtime(project, None);
        let outside = GitFixture::empty();
        let rejected = gateway.get_status(ProjectOptions { project_path: outside.path().to_str().unwrap().into() }, None)
            .await.unwrap_err();
        assert_eq!(rejected.downcast_ref::<GitServiceError>().unwrap().code, Code::GIT_OUTSIDE_BASE);

        let missing = repo.path().join("missing");
        let missing = missing.to_str().unwrap();
        let absent = gateway.get_workbench_snapshot(GitWorkbenchSnapshotOptions {
            project_path: missing.into(), mode: GitReviewMode::Working, context: 3,
            selected_file: OptionalNullable::ABSENT, body_candidate_count: None,
        }, None).await.unwrap();
        assert!(matches!(absent.result, GitWorkbenchSnapshotResponse::NotGitRepository { project, .. } if project == missing));
        assert!(absent.diagnostics.is_none());
        assert_eq!(absent.scope.instance_id, "serving-test");

        let rejected = gateway.get_review_document_file_bodies(
            ExecutionGitReviewDocumentFileBodiesOptions {
                project_path: project.into(), files: vec!["a.txt".into()], purpose: GitReviewBodyPurpose::Visible,
                document: GitReviewDocumentRef {
                    executor_id: "local".into(), instance_id: "prior-instance".into(), document_id: "synthetic-document".into(),
                },
            }, None,
        ).await.unwrap_err();
        assert_eq!(rejected.downcast_ref::<GitServiceError>().unwrap().code, Code::GIT_STALE_DOCUMENT);

        gateway.dispose();
        let rejected = gateway.get_status(ProjectOptions { project_path: String::new() }, None).await.unwrap_err();
        assert_eq!(rejected.downcast_ref::<GitServiceError>().unwrap().code, Code::GIT_INVALID_INPUT);
        let retired = gateway.get_status(ProjectOptions { project_path: project.into() }, None).await.unwrap_err();
        assert!(as_agent_call_error(retired.as_ref()).is_some());
        assert_eq!(retired.to_string(), "Git serving instance retired");
    }).await;
}

async fn reference(project: &str, action: &str, env: Option<&ChildEnvironment>) -> String {
    let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
        .find(|path| path.is_file())
        .unwrap();
    let mut command = Command::new(bun);
    if let Some(env) = env {
        command.env_clear().envs(env.iter().cloned());
    }
    let mut child = command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/git-runtime.ts"
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&json!({"projectPath": project, "action": action})).unwrap())
        .await
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

#[tokio::test]
async fn review_diagnostic_fields_follow_the_bun_runtime_order() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            tokio::fs::write(repo.path().join("a.txt"), "one\nnew\n")
                .await
                .unwrap();
            repo.run(&["commit", "-am", "a changed file"]).await;
            let runtime = runtime(project, None);
            let snapshot = runtime
                .get_commit_snapshot(
                    GitCommitSnapshotOptions {
                        project_path: project.into(),
                        commit: "HEAD".into(),
                        parent: OptionalNullable::ABSENT,
                        context: None,
                        body_candidate_count: None,
                    },
                    None,
                )
                .await
                .unwrap();
            let GitCommitSnapshotResponse::Ready(snapshot) = snapshot.result else {
                panic!("expected commit snapshot");
            };
            let scope = GitReviewDocumentRef {
                executor_id: "local".into(),
                instance_id: "serving-test".into(),
                document_id: snapshot.document_id,
            };
            let mut response = runtime
                .get_review_document_file_bodies(
                    ExecutionGitReviewDocumentFileBodiesOptions {
                        project_path: project.into(),
                        files: vec!["a.txt".into()],
                        purpose: GitReviewBodyPurpose::Visible,
                        document: scope.clone(),
                    },
                    None,
                )
                .await
                .unwrap();
            let GitReviewDocumentFileBodiesResponse::Ready {
                ref mut document_id,
                ..
            } = response.result
            else {
                panic!("expected ready review bodies");
            };
            assert_eq!(*document_id, scope.document_id);
            *document_id = "<document>".into();
            let diagnostics = response.diagnostics.as_mut().unwrap();
            assert_eq!(diagnostics.metrics.cache_hits, Some(Number(0.0)));
            for phase in &mut diagnostics.metrics.phases {
                phase.duration_ms = Number(0.0);
            }
            for command in &mut diagnostics.commands {
                command.duration_ms = Number(0.0);
            }
            assert_eq!(
                serde_json::to_string(&response).unwrap(),
                reference(project, "review", None).await
            );
        })
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn worker_path_is_inherited_and_truncation_follows_diagnostics_for_commit_and_stage() {
    LocalSet::new().run_until(async {
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;
        use garcon_contract::git::{CommitOptions, GitStageMode, StagePathsOptions};

        let repo = GitFixture::with_commit().await;
        let project = repo.path().to_str().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|dir| dir.join("git")).find(|path| path.is_file()).unwrap();
        let env: ChildEnvironment = std::env::vars_os().filter(|(key, _)| key != "PATH").chain([
            (OsString::from("PATH"), tools.path().as_os_str().into()),
            (OsString::from("RUNTIME_TEST_REAL_GIT"), real_git.into_os_string()),
        ]).collect::<Vec<_>>().into();
        let runtime = runtime(project, Some(env.clone()));
        let request = ProjectOptions { project_path: project.into() };
        let missing = runtime.get_status(request.clone(), None).await.unwrap_err();
        assert_eq!(missing.downcast_ref::<GitServiceError>().unwrap().code, Code::GIT_MISSING);

        let git = tools.path().join("git");
        tokio::fs::write(&git, "#!/bin/sh\ncase \"$1\" in\n commit|add) /usr/bin/head -c 40000 /dev/zero | /usr/bin/tr '\\000' x ;;\n *) exec \"$RUNTIME_TEST_REAL_GIT\" \"$@\" ;;\nesac\n").await.unwrap();
        tokio::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).await.unwrap();
        assert_eq!(runtime.get_status(request, None).await.unwrap().result.branch, "main");
        let head = repo.run(&["rev-parse", "HEAD"]).await;
        tokio::fs::write(repo.path().join(".git/MERGE_HEAD"), head).await.unwrap();
        let commit = runtime.commit(CommitOptions {
            project_path: project.into(), message: "test truncated output".into(), files: vec!["a.txt".into()],
        }, None).await.unwrap();
        let stage = runtime.stage_paths(StagePathsOptions {
            project_path: project.into(), paths: vec!["a.txt".into()], mode: GitStageMode::Stage,
        }, None).await.unwrap();
        assert_eq!(commit.output_truncated, Some(true));
        assert_eq!(stage.output_truncated, Some(true));
        assert_eq!(commit.result.output.len(), 32768);
        let wire = format!("[{},{}]", serde_json::to_string(&commit).unwrap(), serde_json::to_string(&stage).unwrap());
        assert_eq!(wire, reference(project, "mutations", Some(&env)).await);
    }).await;
}
