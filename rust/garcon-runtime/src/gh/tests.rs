use std::ffi::OsString;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use garcon_contract::gh::{
    CreatePullRequestCommentRequest, GetPullRequestRequest, GetPullRequestReviewTargetRequest,
    GhActorIdentity, GhAvailabilityReason, GhRepositoryIdentity, ListPullRequestsRequest,
    MinimizePullRequestCommentRequest, PullRequestCommentExpectation, PullRequestReviewRequest,
    PullRequestReviewState,
};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_contract::git_execution::GitExecutorScope;
use garcon_interface::git::ExecutionGhService;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, process::Command, task::LocalSet, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::ChildEnvironment;
use crate::git::git_fixture::GitFixture;
use crate::git::runtime::{GitRuntime, GitRuntimeOptions};
use crate::git::service_errors::gh_service_error;

use super::gh_types::{GhCommandOptions, GhDomainError, GhProcessError};
use super::run::{GhOutputLimitError, run_gh, run_gh_mutation};

fn real_executable(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .unwrap()
}

fn child_env(bin: &Path, home: &Path) -> ChildEnvironment {
    vec![
        (OsString::from("PATH"), bin.as_os_str().into()),
        ("HOME".into(), home.as_os_str().into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
    ]
    .into()
}

struct Fixture {
    repo: GitFixture,
    bin: tempfile::TempDir,
    bun: PathBuf,
}

impl Fixture {
    async fn new() -> Self {
        let repo = GitFixture::with_commit().await;
        let bin = tempfile::tempdir().unwrap();
        let bun = real_executable("bun");
        symlink(&bun, bin.path().join("bun")).unwrap();
        symlink(real_executable("git"), bin.path().join("git")).unwrap();
        let gh = bin.path().join("gh");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../server/remote/__tests__/fixtures/fake-gh.js"
            ),
            &gh,
        )
        .unwrap();
        std::fs::set_permissions(gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self { repo, bin, bun }
    }

    fn project(&self) -> &str {
        self.repo.path().to_str().unwrap()
    }

    fn runtime(&self) -> GitRuntime {
        GitRuntime::new(GitRuntimeOptions {
            scope: GitExecutorScope {
                executor_id: "local".into(),
                instance_id: "synthetic".into(),
            },
            project_base_path: self.project().into(),
            child_environment: Some(child_env(self.bin.path(), self.repo.path())),
            review_registry: None,
            assert_available: None,
        })
    }

    fn write(&self, file: &str, value: &Value) {
        std::fs::write(
            self.repo.path().join(file),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }

    fn configure(&self, config: Value) {
        self.write("gh-fixture.json", &config);
    }

    fn exists(&self, file: &str) -> bool {
        self.repo.path().join(file).exists()
    }

    fn comments(&self) -> Value {
        garcon_js::json::from_slice(
            &std::fs::read(self.repo.path().join("gh-comments.json")).unwrap(),
        )
        .unwrap()
    }

    fn calls(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.repo.path().join("gh-calls.jsonl")).unwrap();
        let mut calls: Vec<_> = text.lines().map(str::to_owned).collect();
        calls.sort();
        calls
    }

    async fn reference(&self, calls: &Value) -> String {
        let mut child = Command::new(&self.bun)
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/gh-runtime.ts"
            ))
            .env_clear()
            .envs(child_env(self.bin.path(), self.repo.path()).iter().cloned())
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
            .write_all(
                &serde_json::to_vec(&json!({
                    "root": self.project(), "calls": calls,
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn list(&self) -> ListPullRequestsRequest {
        ListPullRequestsRequest {
            project_path: self.project().into(),
            repository: Some(repository()),
        }
    }

    fn pull(&self, number: u64) -> GetPullRequestRequest {
        GetPullRequestRequest {
            project_path: self.project().into(),
            repository: repository(),
            number,
        }
    }

    fn target(&self, number: u64) -> GetPullRequestReviewTargetRequest {
        GetPullRequestReviewTargetRequest {
            project_path: self.project().into(),
            repository: repository(),
            number,
            marker: "garcon-review ".into(),
        }
    }

    fn post(&self, number: u64, body: String) -> CreatePullRequestCommentRequest {
        CreatePullRequestCommentRequest {
            project_path: self.project().into(),
            repository: repository(),
            actor: actor(),
            number,
            body,
            expected: PullRequestCommentExpectation {
                state: PullRequestReviewState::Open,
                head_ref_oid: "a".repeat(40),
            },
        }
    }
}

fn repository() -> GhRepositoryIdentity {
    GhRepositoryIdentity {
        host: "git.example.invalid".into(),
        name_with_owner: "synthetic/repository".into(),
    }
}

fn actor() -> GhActorIdentity {
    GhActorIdentity {
        id: "actor:synthetic".into(),
        login: "synthetic".into(),
    }
}

fn wire<T: Serialize>(result: &T) -> String {
    serde_json::to_string(result).unwrap()
}

fn service_error<'a>(error: &'a (dyn std::error::Error + 'static)) -> &'a GitServiceError {
    error.downcast_ref::<GitServiceError>().unwrap()
}

fn error_wire(error: &GitServiceError) -> String {
    wire(&json!({ "code": error.code, "message": error.message, "status": error.status }))
}

#[tokio::test]
async fn auth_list_detail_long_comment_marker_and_minimization_match_bun_bytes() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new().await;
        let gh = fixture.runtime();
        fixture.configure(json!({
            "label": "synthetic",
            "pulls": [
                { "number": 1, "reviewRequests": ["synthetic"], "labels": ["bug"], "checks": "SUCCESS" },
                { "number": 2, "author": { "login": "other", "__typename": "Bot" }, "isCrossRepository": true, "teamReviewRequested": true },
                { "number": 3, "state": "CLOSED" },
            ],
            "commentPages": [
                [{"id": 1, "path": "example.txt", "line": 1, "side": "RIGHT", "body": "first page"}],
                [{"id": 2, "path": "example.txt", "line": 2, "side": "LEFT", "body": "second page"}],
            ],
        }));
        let marker = format!("<!-- garcon-review synthetic/repository#1 {} -->", "a".repeat(40));
        let body = format!("{}\n{marker}", "review line\n".repeat(5_000));
        let post = fixture.post(1, body.clone());
        let list = gh.list_pull_requests(fixture.list(), None).await.unwrap();
        assert_eq!(list.result.pulls.len(), 2);
        assert_eq!(list.result.pulls[0].review_request, Some(PullRequestReviewRequest::Me));
        assert_eq!(list.result.pulls[1].review_request, Some(PullRequestReviewRequest::Team));
        let detail = gh.get_pull_request(fixture.pull(1), None).await.unwrap();
        assert_eq!(detail.result.threads.len(), 2);
        let status = gh.get_status(None).await.unwrap();
        assert_eq!(status.result.reason, GhAvailabilityReason::Authenticated);
        let created = gh.create_pull_request_comment(post.clone(), None).await.unwrap();
        assert_eq!(fixture.comments()[0]["body"], body);
        let target = gh.get_pull_request_review_target(fixture.target(1), None).await.unwrap();
        assert_eq!(target.result.marked_comments[0].marker, marker);
        let minimize = MinimizePullRequestCommentRequest {
            project_path: fixture.project().into(), repository: repository(),
            actor: actor(), comment_id: created.result.id.clone(),
        };
        let minimized = gh.minimize_pull_request_comment(minimize.clone(), None).await.unwrap();
        assert!(minimized.result.minimized);
        let after = gh.get_pull_request_review_target(fixture.target(1), None).await.unwrap();
        assert!(after.result.marked_comments[0].is_minimized);
        let calls = fixture.calls();
        std::fs::remove_file(fixture.repo.path().join("gh-calls.jsonl")).unwrap();
        std::fs::remove_file(fixture.repo.path().join("gh-comments.json")).unwrap();
        let rust = [wire(&list), wire(&detail), wire(&status), wire(&created), wire(&target), wire(&minimized), wire(&after)].join(",");
        let bun = fixture.reference(&json!([
            ["listPullRequests", fixture.list()], ["getPullRequest", fixture.pull(1)], ["getStatus", {}],
            ["createPullRequestComment", post], ["getPullRequestReviewTarget", fixture.target(1)],
            ["minimizePullRequestComment", minimize], ["getPullRequestReviewTarget", fixture.target(1)],
        ])).await;
        assert_eq!(format!("[{rust}]"), bun);
        assert_eq!(calls, fixture.calls(), "argv, including host, repo, and stdin switch");
    }).await;
}

#[tokio::test]
async fn paginates_nested_policy_connections_and_finds_markers_outside_the_first_page() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new().await;
        let gh = fixture.runtime();
        let labels: Vec<_> = (0..101).map(|index| format!("label-{index}")).collect();
        let mut reviewers: Vec<_> = (0..100).map(|index| format!("reviewer-{index}")).collect();
        reviewers.push("synthetic".into());
        let pulls: Vec<_> = (1..=101).map(|number| {
            if number == 101 { json!({ "number": number, "labels": labels, "reviewRequests": reviewers }) }
            else { json!({ "number": number, "reviewRequests": ["synthetic"] }) }
        }).collect();
        let marker = format!("<!-- garcon-review Synthetic/Repository#101 {} -->", "a".repeat(64));
        let comments: Vec<_> = (0..101).map(|index| json!({
            "id": format!("comment-{index}"), "number": 101, "body": if index == 100 { &marker } else { "unrelated" },
        })).collect();
        fixture.configure(json!({ "label": "synthetic", "pulls": pulls, "comments": comments }));
        let listed = gh.list_pull_requests(fixture.list(), None).await.unwrap();
        assert_eq!(listed.result.pulls.len(), 101);
        assert_eq!(listed.result.pulls[100].labels, labels);
        assert_eq!(listed.result.pulls[100].review_request, Some(PullRequestReviewRequest::Me));
        let reviewed = gh.get_pull_request_review_target(fixture.target(101), None).await.unwrap();
        assert_eq!(reviewed.result.marked_comments[0].comment.id, "comment-100");
        assert_eq!(reviewed.result.marked_comments[0].marker, marker);
        assert_eq!(
            format!("[{},{}]", wire(&listed), wire(&reviewed)),
            fixture.reference(&json!([["listPullRequests", fixture.list()], ["getPullRequestReviewTarget", fixture.target(101)]])).await,
        );
        fixture.configure(json!({ "label": "synthetic", "incompleteConnection": true }));
        let list = gh.list_pull_requests(fixture.list(), None).await.unwrap_err();
        let target = gh.get_pull_request_review_target(fixture.target(1), None).await.unwrap_err();
        for error in [&list, &target] {
            assert_eq!(service_error(error.as_ref()).message, "GitHub returned an incomplete connection.");
        }
        assert_eq!(
            format!("[{},{}]", error_wire(service_error(list.as_ref())), error_wire(service_error(target.as_ref()))),
            fixture.reference(&json!([["listPullRequests", fixture.list()], ["getPullRequestReviewTarget", fixture.target(1)]])).await,
        );
    }).await;
}

#[tokio::test]
async fn fences_changed_repositories_accounts_and_pr_heads_before_posting() {
    LocalSet::new()
        .run_until(async {
            for change in [
                json!({ "state": "CLOSED" }),
                json!({ "state": "MERGED" }),
                json!({ "headRefOid": "b".repeat(40) }),
            ] {
                let fixture = Fixture::new().await;
                let gh = fixture.runtime();
                fixture.configure(json!({ "label": "synthetic", "holdPostingActor": true }));
                let posting =
                    gh.create_pull_request_comment(fixture.post(1, "review".into()), None);
                let release = async {
                    timeout(Duration::from_secs(5), async {
                        while !fixture.exists("gh-actor-started") {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    })
                    .await
                    .unwrap();
                    let mut pull = change;
                    pull["number"] = 1.into();
                    fixture.configure(json!({ "label": "synthetic", "pulls": [pull] }));
                    fixture.write("gh-actor-release", &json!("released"));
                };
                let (error, ()) = tokio::join!(posting, release);
                assert_eq!(
                    service_error(error.unwrap_err().as_ref()).code,
                    Code::GH_STALE_PULL_REQUEST
                );
                assert!(!fixture.exists("gh-comments.json"));
            }
            let fixture = Fixture::new().await;
            let gh = fixture.runtime();
            fixture.configure(json!({ "label": "synthetic" }));
            gh.get_pull_request_review_target(fixture.target(1), None)
                .await
                .unwrap();
            for change in [
                json!({ "label": "other" }),
                json!({ "label": "synthetic", "login": "other" }),
            ] {
                fixture.configure(change);
                let post = fixture.post(1, "review".into());
                let error = gh
                    .create_pull_request_comment(post.clone(), None)
                    .await
                    .unwrap_err();
                assert_eq!(
                    service_error(error.as_ref()).code,
                    Code::GH_MUTATION_REJECTED
                );
                assert!(!fixture.exists("gh-comments.json"));
                assert_eq!(
                    format!("[{}]", error_wire(service_error(error.as_ref()))),
                    fixture
                        .reference(&json!([["createPullRequestComment", post]]))
                        .await,
                );
            }
        })
        .await;
}

#[tokio::test]
async fn never_confirms_written_comments_after_a_transport_or_identity_failure() {
    LocalSet::new().run_until(async {
        let marker = format!("<!-- garcon-review synthetic/repository#1 {} -->", "a".repeat(40));
        let body = format!("Review\n{marker}");
        for (key, value) in [
            ("commentFailureAfterWrite", json!("Post: connection reset by peer")),
            ("commentResponse", json!("{")),
            ("commentResponse", json!("{}")),
            ("commentResponse", json!("null")),
            ("commentResponse", json!(wire(&json!({ "html_url": 7, "node_id": "id", "user": {"node_id": actor().id} })))),
            ("commentResponse", json!(wire(&json!({ "html_url": "", "node_id": "x".repeat(257), "user": {"node_id": actor().id} })))),
            ("commentAuthor", json!({ "id": "actor:other", "login": "other" })),
        ] {
            let fixture = Fixture::new().await;
            let gh = fixture.runtime();
            let mut config = json!({ "label": "synthetic" });
            config[key] = value;
            fixture.configure(config);
            let post = fixture.post(1, body.clone());
            let error = gh.create_pull_request_comment(post.clone(), None).await.unwrap_err();
            assert_eq!(service_error(error.as_ref()).code, Code::GIT_MUTATION_OUTCOME_UNKNOWN);
            assert_eq!(fixture.comments()[0]["body"], body);
            let target = gh.get_pull_request_review_target(fixture.target(1), None).await.unwrap();
            assert_eq!(target.result.marked_comments.len(), 1);
            std::fs::remove_file(fixture.repo.path().join("gh-comments.json")).unwrap();
            assert_eq!(
                format!("[{},{}]", error_wire(service_error(error.as_ref())), wire(&target)),
                fixture.reference(&json!([["createPullRequestComment", post], ["getPullRequestReviewTarget", fixture.target(1)]])).await,
            );
        }
    }).await;
}

#[tokio::test]
async fn boundary_missing_pull_and_optional_review_thread_failures_match_bun() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let gh = fixture.runtime();
            fixture.configure(json!({ "label": "synthetic", "commentsFail": true }));
            let detail = gh.get_pull_request(fixture.pull(1), None).await.unwrap();
            assert!(detail.result.threads.is_empty());
            let mut wrong = fixture.target(1);
            wrong.repository.host = "other.example.invalid".into();
            let missing = gh
                .get_pull_request_review_target(fixture.target(99), None)
                .await
                .unwrap_err();
            let conflict = gh
                .get_pull_request_review_target(wrong.clone(), None)
                .await
                .unwrap_err();
            assert_eq!(service_error(missing.as_ref()).code, Code::GH_NOT_FOUND);
            assert_eq!(service_error(conflict.as_ref()).code, Code::GIT_CONFLICT);
            assert_eq!(
                format!(
                    "[{},{},{}]",
                    wire(&detail),
                    error_wire(service_error(missing.as_ref())),
                    error_wire(service_error(conflict.as_ref()))
                ),
                fixture
                    .reference(&json!([
                        ["getPullRequest", fixture.pull(1)],
                        ["getPullRequestReviewTarget", fixture.target(99)],
                        ["getPullRequestReviewTarget", wrong],
                    ]))
                    .await,
            );
            let outside = GitFixture::with_commit().await;
            let mut request = fixture.pull(1);
            request.project_path = outside.path().to_str().unwrap().into();
            let outside = gh.get_pull_request(request, None).await.unwrap_err();
            assert_eq!(service_error(outside.as_ref()).code, Code::GIT_OUTSIDE_BASE);
        })
        .await;
}

#[tokio::test]
async fn rejects_wrong_types_in_fields_copied_from_gh() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let gh = fixture.runtime();
            fixture
                .configure(json!({ "label": "synthetic", "pulls": [{ "number": 1, "title": 7 }] }));
            let list = gh
                .list_pull_requests(fixture.list(), None)
                .await
                .unwrap_err();
            let detail = gh
                .get_pull_request(fixture.pull(1), None)
                .await
                .unwrap_err();
            for error in [&list, &detail] {
                assert_eq!(service_error(error.as_ref()).code, Code::GIT_INVALID_RESULT);
            }
            assert_eq!(
                format!(
                    "[{},{}]",
                    error_wire(service_error(list.as_ref())),
                    error_wire(service_error(detail.as_ref()))
                ),
                fixture
                    .reference(&json!([
                        ["listPullRequests", fixture.list()],
                        ["getPullRequest", fixture.pull(1)]
                    ]))
                    .await,
            );
        })
        .await;
}

struct Runner {
    cwd: tempfile::TempDir,
    bin: tempfile::TempDir,
}

impl Runner {
    fn new(script: &str) -> Self {
        let cwd = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        if !script.is_empty() {
            let gh = bin.path().join("gh");
            std::fs::write(&gh, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { cwd, bin }
    }

    fn path(&self) -> &str {
        self.cwd.path().to_str().unwrap()
    }

    fn options(&self) -> GhCommandOptions {
        GhCommandOptions {
            base_environment: Some(child_env(self.bin.path(), self.cwd.path())),
            ..Default::default()
        }
    }
}

fn args(command: &str) -> Vec<String> {
    vec![command.into()]
}

fn mapped(result: ExecutorResult<impl std::fmt::Debug>) -> GitServiceError {
    *gh_service_error(result.unwrap_err())
        .downcast::<GitServiceError>()
        .unwrap()
}

async fn bun_spawn_error(runner: &Runner, cwd: &str) -> Value {
    let output = Command::new(real_executable("bun"))
        .args([
            "-e",
            r#"
if (Bun.version !== '1.4.3') throw new Error('Bun 1.4.3 required');
try {
  const child = Bun.spawn(['gh', 'auth'], { cwd: Bun.argv.at(-1) });
  await child.exited;
  throw new Error('expected a spawn failure');
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message }));
}
"#,
            "--",
            cwd,
        ])
        .env_clear()
        .envs(
            child_env(runner.bin.path(), runner.cwd.path())
                .iter()
                .cloned(),
        )
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn distinguishes_missing_gh_from_existing_executable_with_bad_cwd() {
    LocalSet::new()
        .run_until(async {
            let empty = Runner::new("");
            let present = Runner::new("printf 'ok\\n'");
            let file = empty.cwd.path().join("not-a-directory");
            std::fs::write(&file, "file").unwrap();
            let cwd = file.to_str().unwrap();
            let reference = bun_spawn_error(&empty, cwd).await;
            assert_eq!(reference["code"], "ENOENT");
            let missing = run_gh(cwd, args("auth"), empty.options())
                .await
                .unwrap_err();
            let missing_gh = missing.downcast_ref::<GhProcessError>().unwrap();
            assert_eq!(missing_gh.stderr, "Executable not found in $PATH: \"gh\"");
            assert_eq!(reference["message"], missing_gh.stderr);
            assert_eq!(
                service_error(gh_service_error(missing).as_ref()).code,
                Code::GH_MISSING
            );
            let bad_cwd = run_gh(cwd, args("auth"), present.options())
                .await
                .unwrap_err();
            let reference = bun_spawn_error(&present, cwd).await;
            assert_eq!(reference["code"], "ENOTDIR");
            assert_eq!(
                bad_cwd.downcast_ref::<std::io::Error>().unwrap().kind(),
                std::io::ErrorKind::NotADirectory
            );
            assert_eq!(
                service_error(gh_service_error(bad_cwd).as_ref()).code,
                Code::GIT_INVALID_INPUT
            );
            let rejected =
                mapped(run_gh_mutation(empty.path(), args("api"), empty.options()).await);
            assert_eq!(rejected.code, Code::GH_MUTATION_REJECTED);
            assert!(rejected.message.contains("not installed"));
            let output = run_gh(present.path(), args("auth"), present.options())
                .await
                .unwrap();
            assert_eq!(
                (output.stdout.as_str(), output.stderr.as_str()),
                ("ok\n", "")
            );
        })
        .await;
}

#[tokio::test]
async fn drains_bounded_output_and_treats_only_definite_non_timeout_4xx_as_rejected() {
    LocalSet::new()
        .run_until(async {
            let runner = Runner::new(
                r#"
case "$1" in
  stdout) exec /usr/bin/head -c 4194304 /dev/zero ;;
  stderr) exec /usr/bin/head -c 4194304 /dev/zero >&2 ;;
  CONNECTION) printf 'connection reset by peer' >&2; exit 1 ;;
  *) printf 'other detail\ngh: Request failed (HTTP %s)\n' "$1" >&2; exit 1 ;;
esac"#,
            );
            let mut options = runner.options();
            options.max_stdout_bytes = Some(1024);
            let error = run_gh(runner.path(), args("stdout"), options)
                .await
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<GhOutputLimitError>()
                    .unwrap()
                    .max_bytes,
                1024
            );
            assert_eq!(
                service_error(gh_service_error(error).as_ref()).code,
                Code::GIT_RESULT_TOO_LARGE
            );
            let mut options = runner.options();
            options.max_stdout_bytes = Some(1);
            assert_eq!(
                mapped(run_gh_mutation(runner.path(), args("stdout"), options).await).code,
                Code::GIT_MUTATION_OUTCOME_UNKNOWN
            );
            let mut options = runner.options();
            options.max_stderr_bytes = Some(1024);
            assert_eq!(
                run_gh(runner.path(), args("stderr"), options)
                    .await
                    .unwrap()
                    .stderr,
                "\0".repeat(1024)
            );
            for status in [
                "400",
                "401",
                "403",
                "404",
                "422",
                "429",
                "408",
                "500",
                "502",
                "CONNECTION",
            ] {
                let error =
                    mapped(run_gh_mutation(runner.path(), args(status), runner.options()).await);
                assert_eq!(
                    error.code,
                    match status {
                        "400" | "401" | "403" | "404" | "422" | "429" => Code::GH_MUTATION_REJECTED,
                        _ => Code::GIT_MUTATION_OUTCOME_UNKNOWN,
                    },
                    "{status}"
                );
            }
            let error: Box<dyn std::error::Error> =
                GhDomainError::new("NOT_FOUND", "Pull request not found.").into();
            assert_eq!(
                service_error(gh_service_error(error).as_ref()).code,
                Code::GH_NOT_FOUND
            );
        })
        .await;
}

#[tokio::test]
async fn caller_abort_and_scoped_deadline_reap_gh_without_confusing_missing_executable() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            fixture.configure(json!({ "label": "synthetic", "wait": true }));
            let gh = fixture.runtime();
            let signal = CancellationToken::new();
            let status = gh.get_status(Some(ExecutorCallOptions {
                signal: Some(signal.clone()),
                ..Default::default()
            }));
            let abort = async {
                timeout(Duration::from_secs(5), async {
                    while !fixture.exists("gh-started") {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                signal.cancel();
            };
            let (error, ()) = timeout(Duration::from_secs(6), async {
                tokio::join!(status, abort)
            })
            .await
            .unwrap();
            assert_eq!(
                service_error(error.unwrap_err().as_ref()).code,
                Code::GIT_TIMEOUT
            );
            let runner = Runner::new("exec /bin/sleep 10");
            let mut options = runner.options();
            options.timeout_ms = Some(30.0);
            let error = run_gh(runner.path(), args("wait"), options)
                .await
                .unwrap_err();
            let process = error.downcast_ref::<GhProcessError>().unwrap();
            assert!(process.timed_out);
            assert_eq!(process.code, Some(143));
            assert_eq!(
                service_error(gh_service_error(error).as_ref()).code,
                Code::GIT_TIMEOUT
            );
            let empty = Runner::new("");
            let unavailable = GitRuntime::new(GitRuntimeOptions {
                scope: GitExecutorScope {
                    executor_id: "local".into(),
                    instance_id: "synthetic".into(),
                },
                project_base_path: empty.path().into(),
                child_environment: empty.options().base_environment,
                review_registry: None,
                assert_available: None,
            });
            assert_eq!(
                unavailable.get_status(None).await.unwrap().result.reason,
                GhAvailabilityReason::GhMissing
            );
        })
        .await;
}
