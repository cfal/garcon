use std::cell::RefCell;
use std::path::PathBuf;
use std::process::Stdio;

use garcon_cases::{CaseError, markers, replay, text, unknown};
use garcon_contract::git::{
    BlameOptions, CreateWorktreeOptions, FileHistoryOptions, GraphOptions, RemoveWorktreeOptions,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::task::LocalSet;

use super::file_history::{get_blame, get_file_history, get_graph};
use super::quick_summary::{
    get_quick_summary, get_quick_summary_with, not_repository_quick_summary,
};
use super::working_path_token::{
    GitWorkingPathToken, WorkingPathTokenInputs, capture_working_path_tokens,
    changed_working_path_tokens,
};
use super::working_tree_observation::{
    capture_working_tree_observation, get_working_tree_fingerprint,
    is_working_tree_observation_current, not_repository_fingerprint, parse_ls_files_stage_z,
};
use super::worktree_admin::read_admin_worktree_records;
use super::worktree_layout::WorktreeLayout;
use super::worktrees::{
    WorktreeOperations, WorktreeSource, create_worktree, get_repo_info, remove_worktree,
    serialize_worktree_mtime,
};

use super::git_fixture::GitFixture;

const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/git");

fn serialized(value: impl Serialize) -> Value {
    garcon_js::json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap()
}

#[test]
fn recorded_quick_summary_matches() {
    replay(
        PathBuf::from(CASES).join("quick-summary"),
        |function, args| match function {
            "notRepositoryQuickSummary" => Ok(serialized(not_repository_quick_summary(
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?,
            ))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn recorded_working_tree_observation_matches() {
    replay(
        PathBuf::from(CASES).join("working-tree-observation"),
        |function, args| {
            let value =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            match function {
                "parseLsFilesStageZ" => Ok(markers::marker(
                    "map",
                    serialized(
                        parse_ls_files_stage_z(value)
                            .into_iter()
                            .collect::<Vec<_>>(),
                    ),
                )),
                "notRepositoryFingerprint" => Ok(serialized(not_repository_fingerprint(value))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

fn path_tokens(
    function: &str,
    argument: Option<&Value>,
) -> Result<IndexMap<String, GitWorkingPathToken>, CaseError> {
    let value = argument
        .filter(|value| markers::kind(value) == Some("map"))
        .and_then(|value| value.get("value"))
        .ok_or_else(|| CaseError::unhandled(function))?;
    serde_json::from_value::<Vec<(String, GitWorkingPathToken)>>(
        unknown(function, Some(value))?.into_owned(),
    )
    .map(|tokens| tokens.into_iter().collect())
    .map_err(|err| CaseError::undeliverable(err.to_string()))
}

#[test]
fn recorded_working_path_tokens_match() {
    replay(
        PathBuf::from(CASES).join("working-path-token"),
        |function, args| match function {
            "changedWorkingPathTokens" => Ok(serialized(changed_working_path_tokens(
                &path_tokens(function, args.first())?,
                &path_tokens(function, args.get(1))?,
            ))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn recorded_worktree_mtime_matches() {
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};

    replay(PathBuf::from(CASES).join("worktrees"), |function, args| {
        if function != "serializeWorktreeMtime" {
            return Err(CaseError::unhandled(function));
        }
        let encoded = args
            .first()
            .filter(|value| markers::kind(value) == Some("date"))
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str)
            .ok_or_else(|| CaseError::undeliverable("expected a Date marker"))?;
        let date = OffsetDateTime::parse(encoded, &Rfc3339)
            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
        Ok(serialized(serialize_worktree_mtime(
            (date.unix_timestamp_nanos() / 1_000_000) as f64,
        )))
    });
}

async fn original_reads(base: &str, reads: Vec<Value>) -> Vec<Value> {
    let mut bun = Command::new("bun")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/oracles/git-reads.ts"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    bun.stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&json!({ "base": base, "reads": reads })).unwrap())
        .await
        .unwrap();
    let output = bun.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "original GitRuntime: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut results: Vec<Value> = garcon_js::json::from_slice(&output.stdout).unwrap();
    for result in &mut results {
        let fields = result.as_object_mut().unwrap();
        assert_eq!(fields.shift_remove("executorId"), Some(json!("local")));
        assert_eq!(
            fields.shift_remove("instanceId"),
            Some(json!("git-oracle-instance"))
        );
        assert!(
            fields
                .shift_remove("diagnostics")
                .is_some_and(|value| value.is_object())
        );
    }
    results
}

fn read(method: &str, request: Value) -> Value {
    json!({ "method": method, "request": request })
}

#[cfg(unix)]
#[tokio::test]
async fn compares_commit_history_and_snapshots_for_renames_type_changes_gitlinks_and_non_utf8_paths()
 {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::rc::Rc;

    use garcon_contract::git::{GitCommitSnapshotOptions, GitHistoryCommitListOptions};

    use super::commit_history::{get_commit_snapshot, get_history_commits};
    use super::review_document_registry::GitReviewDocumentRegistry;

    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let root = repo.path().canonicalize().unwrap();
            let project = root.to_str().unwrap();
            tokio::fs::write(root.join("old name"), "a small renamed file\n")
                .await
                .unwrap();
            tokio::fs::write(root.join("changes-type"), "plain\n")
                .await
                .unwrap();
            tokio::fs::write(root.join("binary"), b"\0zero")
                .await
                .unwrap();
            repo.run(&["add", "--", "old name", "changes-type", "binary"])
                .await;
            let first = repo.run(&["rev-parse", "HEAD"]).await;
            let first = first.trim_end();
            repo.run(&[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{first},submodule"),
            ])
            .await;
            repo.run(&["commit", "-m", "seed changed paths"]).await;
            let parent = repo.run(&["rev-parse", "HEAD"]).await;
            let parent = parent.trim_end();

            repo.run(&["mv", "old name", "new name"]).await;
            tokio::fs::remove_file(root.join("changes-type"))
                .await
                .unwrap();
            tokio::fs::symlink("a.txt", root.join("changes-type"))
                .await
                .unwrap();
            tokio::fs::write(root.join("binary"), b"\0one")
                .await
                .unwrap();
            tokio::fs::write(root.join(OsStr::from_bytes(b"non-utf8-\xff")), "one\n")
                .await
                .unwrap();
            repo.git(
                &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                Some(b"changes-type\0binary\0non-utf8-\xff\0"),
            )
            .await;
            repo.run(&[
                "update-index",
                "--cacheinfo",
                &format!("160000,{parent},submodule"),
            ])
            .await;
            repo.run(&["commit", "-m", "change the paths", "-m", "commit body"])
                .await;

            let history = GitHistoryCommitListOptions {
                project_path: project.into(),
                reference: None,
                limit: Some(2),
                offset: None,
            };
            let request = |commit: &str| GitCommitSnapshotOptions {
                project_path: project.into(),
                commit: commit.into(),
                parent: Default::default(),
                context: None,
                body_candidate_count: None,
            };
            let mut original = original_reads(
                project,
                vec![
                    read("getHistoryCommits", serialized(&history)),
                    read("getCommitSnapshot", serialized(request("HEAD"))),
                    read("getCommitSnapshot", serialized(request(first))),
                    read("getCommitSnapshot", serialized(request("missing"))),
                ],
            )
            .await;
            let history = serialized(get_history_commits(&history, None, None).await.unwrap());
            assert_eq!(history["nextOffset"], 2);
            assert_eq!(
                history.to_string(),
                original[0].to_string(),
                "history wire value"
            );
            let registry = Rc::new(GitReviewDocumentRegistry::default());
            for (index, revision) in [(1, "HEAD"), (2, first), (3, "missing")] {
                let mut actual = serialized(
                    get_commit_snapshot(&request(revision), &registry, None, None, None)
                        .await
                        .unwrap(),
                );
                if let Some(document) = actual.get("documentId").and_then(Value::as_str) {
                    let lease = registry.acquire(project, document).unwrap();
                    assert_eq!(
                        uuid::Uuid::parse_str(document).unwrap().get_version_num(),
                        4
                    );
                    assert_eq!(
                        uuid::Uuid::parse_str(original[index]["documentId"].as_str().unwrap())
                            .unwrap()
                            .get_version_num(),
                        4
                    );
                    assert_eq!(
                        lease.document.files_by_path.len(),
                        actual["files"].as_array().unwrap().len()
                    );
                    actual["documentId"] = json!("<document>");
                    original[index]["documentId"] = json!("<document>");
                }
                assert_eq!(
                    actual.to_string(),
                    original[index].to_string(),
                    "snapshot of {revision}"
                );
                if revision == "HEAD" {
                    let files = actual["files"].as_array().unwrap();
                    let file = |name| files.iter().find(|file| file["path"] == name).unwrap();
                    assert_eq!(file("new name")["originalPath"], "old name");
                    assert_eq!(file("changes-type")["status"], "type-changed");
                    assert_eq!(file("binary")["bodyState"], "binary");
                    assert_eq!(file("submodule")["additions"], 1);
                    assert_eq!(file("non-utf8-\u{fffd}")["additions"], 1);
                }
            }
        })
        .await;
}

#[tokio::test]
async fn compares_real_file_history_blame_and_graph_with_the_original_runtime() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let root = repo.path().canonicalize().unwrap();
            let project = root.to_str().unwrap();
            let file = "renamed file.txt";
            repo.run(&["mv", "a.txt", file]).await;
            repo.run(&["commit", "-m", "rename\u{1e}subject"]).await;
            let history = FileHistoryOptions {
                project_path: project.into(),
                file: file.into(),
                limit: None,
            };
            let blame = BlameOptions {
                project_path: project.into(),
                file: file.into(),
                reference: None,
                limit: Some(1),
            };
            let graph = GraphOptions {
                project_path: project.into(),
                limit: None,
            };
            let original = original_reads(
                project,
                vec![
                    read("getFileHistory", serialized(&history)),
                    read("getBlame", serialized(&blame)),
                    read("getGraph", serialized(&graph)),
                ],
            )
            .await;
            let history = get_file_history(&history, None).await.unwrap();
            assert_eq!(history.commits.len(), 2);
            assert_eq!(history.commits[0].subject, "rename\u{1e}subject");
            assert_eq!(serialized(history), original[0], "file history");
            let blame = get_blame(&blame, None).await.unwrap();
            assert!(blame.truncated);
            assert_eq!(blame.lines[0].content, "one");
            assert_eq!(serialized(blame), original[1], "blame");
            assert_eq!(
                serialized(get_graph(&graph, None).await.unwrap()),
                original[2],
                "graph"
            );
        })
        .await;
}

#[tokio::test]
async fn dirty_detached_repository_quick_summary_and_fingerprint_match_the_original() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let root = repo.path().canonicalize().unwrap();
            let project = root.to_str().unwrap();
            repo.run(&["checkout", "--detach"]).await;
            repo.run(&["tag", "release"]).await;
            tokio::fs::write(root.join("a.txt"), b"one\ntwo\n")
                .await
                .unwrap();
            tokio::fs::write(root.join("binary"), [0, 1, 2])
                .await
                .unwrap();
            repo.run(&["add", "binary"]).await;
            tokio::fs::create_dir(root.join("untracked")).await.unwrap();
            tokio::fs::write(
                root.join("untracked").join("large file"),
                "x".repeat(200_000),
            )
            .await
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                tokio::fs::write(
                    root.join(std::ffi::OsStr::from_bytes(b"non-utf8-\xff")),
                    b"one\n",
                )
                .await
                .unwrap();
            }
            let original = original_reads(
                project,
                vec![
                    read("getQuickSummary", json!({ "projectPath": project })),
                    read(
                        "getWorkingTreeFingerprint",
                        json!({ "projectPath": project }),
                    ),
                ],
            )
            .await;
            let trace = RefCell::new(Vec::new());
            let quick = serialized(
                get_quick_summary(project, Some(&trace), None)
                    .await
                    .unwrap(),
            );
            assert_eq!(quick, original[0], "quick summary");
            assert_eq!(quick["branch"], "release");
            assert_eq!(quick["diffStats"], json!({"additions": 1, "deletions": 0}));
            let fingerprint = serialized(
                get_working_tree_fingerprint(project, None, None)
                    .await
                    .unwrap(),
            );
            assert_eq!(
                fingerprint["fingerprint"], original[1]["fingerprint"],
                "$.fingerprint"
            );
            assert_eq!(fingerprint, original[1], "worktree fingerprint");
            let before = capture_working_tree_observation(project, None, None, None)
                .await
                .unwrap();
            assert!(
                is_working_tree_observation_current(&before, None, None)
                    .await
                    .unwrap()
            );
            let paths = vec!["a.txt".into()];
            let before_token = capture_working_path_tokens(
                project,
                &paths,
                WorkingPathTokenInputs::default(),
                None,
            )
            .await
            .unwrap();
            tokio::fs::write(
                root.join("a.txt"),
                b"one\nanother edit with the same status\n",
            )
            .await
            .unwrap();
            let after = capture_working_tree_observation(project, None, None, None)
                .await
                .unwrap();
            assert_eq!(before.status_output, after.status_output);
            assert_ne!(before.fingerprint, after.fingerprint);
            assert!(
                !is_working_tree_observation_current(&before, None, None)
                    .await
                    .unwrap()
            );
            let after_token = capture_working_path_tokens(
                project,
                &paths,
                WorkingPathTokenInputs::default(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(
                changed_working_path_tokens(&before_token, &after_token),
                ["a.txt"]
            );
        })
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn shared_trace_records_concurrent_commands_in_completion_order() {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    use super::run::run_git_traced_shared;
    use super::types::GitCommandOptions;

    LocalSet::new().run_until(async {
        let fixture = tempfile::tempdir().unwrap();
        let cwd = fixture.path().to_str().unwrap();
        let script = fixture.path().join("git");
        std::fs::write(&script, r#"#!/bin/sh
if [ "$1" = first ]; then
    while [ ! -e ready ]; do sleep 0.01; done
    printf 'first stdout'
else
    printf 'second stderr' >&2
    exit 2
fi
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let command_path = std::env::join_paths(
            std::iter::once(fixture.path().to_owned()).chain(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            )),
        ).unwrap();
        let options = GitCommandOptions {
            timeout_ms: Some(3000.0),
            env: Some([(OsString::from("PATH"), Some(command_path))].into()),
            ..Default::default()
        };
        let trace = RefCell::new(Vec::new());
        let (first, second) = tokio::join!(biased;
            run_git_traced_shared(cwd, vec!["first".into()], Some(&trace), options.clone()),
            async {
                let result = run_git_traced_shared(cwd, vec!["second".into()], Some(&trace), options).await;
                tokio::fs::write(fixture.path().join("ready"), "").await.unwrap();
                result
            },
        );
        assert!(first.is_ok());
        assert!(second.is_err());
        let trace = trace.into_inner();
        assert_eq!(trace.iter().map(|entry| &entry.args[0]).collect::<Vec<_>>(), ["second", "first"]);
        assert_eq!((trace[0].failed, trace[0].exit_code, trace[0].stderr_bytes), (Some(true), Some(2), 13));
        assert_eq!((trace[1].failed, trace[1].stdout_bytes), (None, 12));
    }).await;
}

#[tokio::test]
async fn keeps_change_presence_when_optional_diff_totals_fail() {
    use super::run::run_git_traced_shared;
    use super::types::{GitCommandOptions, GitCommandTrace};

    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            tokio::fs::write(repo.path().join("a.txt"), "changed\n")
                .await
                .unwrap();
            let options_seen = RefCell::new(Vec::new());
            let run = async |cwd: &str,
                             args: Vec<String>,
                             trace: Option<&RefCell<Vec<GitCommandTrace>>>,
                             options: GitCommandOptions| {
                if args[0] == "diff" {
                    assert!(options.disable_optional_locks);
                    options_seen
                        .borrow_mut()
                        .push((options.timeout_ms, options.max_stdout_bytes));
                    return Err("Optional diff timed out".into());
                }
                run_git_traced_shared(cwd, args, trace, options).await
            };
            let summary = serialized(
                get_quick_summary_with(project, None, None, &run)
                    .await
                    .unwrap(),
            );
            assert_eq!(
                summary,
                json!({
                    "status": "ready", "project": project, "branch": "main", "hasChanges": true,
                    "hasUntracked": false, "diffStats": null,
                })
            );
            assert_eq!(
                options_seen.into_inner(),
                [(Some(2000.0), Some(1024 * 1024)); 2]
            );
        })
        .await;
}

#[tokio::test]
async fn skips_diffs_in_a_clean_repository_and_collapses_untracked_directories() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            tokio::fs::create_dir_all(repo.path().join(".git/info"))
                .await
                .unwrap();
            tokio::fs::write(repo.path().join(".git/info/exclude"), "\nignored/\n")
                .await
                .unwrap();
            tokio::fs::create_dir(repo.path().join("ignored"))
                .await
                .unwrap();
            tokio::fs::write(repo.path().join("ignored/cache"), "not a change")
                .await
                .unwrap();
            let trace = RefCell::new(Vec::new());
            let clean = serialized(
                get_quick_summary(project, Some(&trace), None)
                    .await
                    .unwrap(),
            );
            assert_eq!(
                clean,
                json!({
                    "status": "ready", "project": project, "branch": "main", "hasChanges": false,
                    "hasUntracked": false, "diffStats": { "additions": 0, "deletions": 0 },
                })
            );
            assert!(
                !trace
                    .borrow()
                    .iter()
                    .any(|entry| matches!(entry.args[0].as_str(), "diff" | "ls-files"))
            );
            trace.borrow_mut().clear();
            let artifacts = repo.path().join("artifacts/nested/cache");
            tokio::fs::create_dir_all(&artifacts).await.unwrap();
            for index in 0..200 {
                tokio::fs::write(artifacts.join(format!("{index}.txt")), "line\n")
                    .await
                    .unwrap();
            }
            let dirty = serialized(
                get_quick_summary(project, Some(&trace), None)
                    .await
                    .unwrap(),
            );
            assert_eq!(
                (
                    dirty["hasChanges"].as_bool(),
                    dirty["hasUntracked"].as_bool()
                ),
                (Some(true), Some(true))
            );
            let trace = trace.borrow();
            let status = trace
                .iter()
                .find(|entry| entry.args[0] == "status")
                .unwrap();
            assert!(
                status
                    .args
                    .iter()
                    .any(|arg| arg == "--untracked-files=normal")
            );
            assert_eq!(status.stdout_bytes, "?? artifacts/\0".len());
            assert!(!trace.iter().any(|entry| entry.args[0] == "diff"));
        })
        .await;
}

#[tokio::test]
async fn preserves_an_unborn_branch_and_includes_staged_additions() {
    let repo = GitFixture::empty();
    let project = repo.path().to_str().unwrap();
    LocalSet::new().run_until(async {
        tokio::fs::write(repo.path().join("a.txt"), "one\n").await.unwrap();
        repo.run(&["init", "-b", "new-project"]).await;
        repo.run(&["add", "a.txt"]).await;
        let summary = serialized(get_quick_summary(project, None, None).await.unwrap());
        assert_eq!(summary, json!({
            "status": "ready", "project": project, "branch": "new-project", "hasChanges": true,
            "hasUntracked": false, "diffStats": { "additions": 1, "deletions": 0 },
        }));
    }).await;
}

#[tokio::test]
async fn returns_typed_non_repository_reads_without_masking_quick_summary_cancellation() {
    use tokio_util::sync::CancellationToken;

    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().to_str().unwrap();
    LocalSet::new()
        .run_until(async {
            assert_eq!(
                get_quick_summary(project, None, None).await.unwrap(),
                not_repository_quick_summary(project)
            );
            assert_eq!(
                get_working_tree_fingerprint(project, None, None)
                    .await
                    .unwrap(),
                not_repository_fingerprint(project)
            );
            let signal = CancellationToken::new();
            signal.cancel();
            let error = get_quick_summary(project, None, Some(&signal))
                .await
                .unwrap_err();
            assert!(super::operation_context::is_git_cancellation(
                error.as_ref()
            ));
        })
        .await;
}

#[tokio::test]
async fn propagates_cancellation_during_optional_diff_collection() {
    use super::run::run_git_traced_shared;
    use super::types::{GitCommandOptions, GitCommandTrace};
    use tokio_util::sync::CancellationToken;

    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            tokio::fs::write(repo.path().join("a.txt"), "changed\n")
                .await
                .unwrap();
            let signal = CancellationToken::new();
            let run = async |cwd: &str,
                             args: Vec<String>,
                             trace: Option<&RefCell<Vec<GitCommandTrace>>>,
                             options: GitCommandOptions| {
                if args[0] == "diff" {
                    signal.cancel();
                }
                run_git_traced_shared(cwd, args, trace, options).await
            };
            let error = get_quick_summary_with(project, None, Some(&signal), &run)
                .await
                .unwrap_err();
            assert!(super::operation_context::is_git_cancellation(
                error.as_ref()
            ));
        })
        .await;
}

#[tokio::test]
async fn reports_root_mtimes_and_keeps_missing_worktrees_available_to_target_discovery() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let root = repo.path().canonicalize().unwrap();
            let project = root.to_str().unwrap();
            let linked = root.join("Zed");
            let missing = root.join("apple");
            repo.run(&["config", "core.ignorecase", "true"]).await;
            repo.run(&["config", "extensions.worktreeConfig", "true"])
                .await;
            tokio::fs::write(root.join(".git/config.worktree"), "")
                .await
                .unwrap();
            repo.run(&["worktree", "add", "-b", "feature", linked.to_str().unwrap()])
                .await;
            repo.run(&[
                "worktree",
                "add",
                "-b",
                "missing",
                missing.to_str().unwrap(),
            ])
            .await;
            std::fs::File::open(&linked)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_784_109_600))
                .unwrap();
            tokio::fs::remove_dir_all(&missing).await.unwrap();

            let layout = WorktreeLayout {
                worktree_root: project.into(),
                common_dir: root.join(".git").to_str().unwrap().into(),
                ref_format: "files".into(),
            };
            let admin = read_admin_worktree_records(&layout).await.unwrap().unwrap();
            assert_eq!(admin[0].path, project);
            assert_eq!(admin.len(), 3);
            assert!(
                admin
                    .iter()
                    .any(|entry| entry.path == missing.to_str().unwrap()
                        && entry.branch == "missing")
            );
            let automatic = WorktreeOperations::default();
            let git = WorktreeOperations {
                source: WorktreeSource::Git,
                ..Default::default()
            };
            let expected = original_reads(
                project,
                vec![
                    read("getWorktrees", json!({ "projectPath": project })),
                    read("getTargetCandidates", json!({ "projectPath": project })),
                    read("getRepoInfo", json!({ "projectPath": project })),
                ],
            )
            .await;
            let result = automatic.get_worktrees(project, None).await.unwrap();
            assert_eq!(result, git.get_worktrees(project, None).await.unwrap());
            assert_eq!(serialized(&result), expected[0], "worktrees");
            let paths: Vec<&str> = result
                .worktrees
                .iter()
                .map(|entry| entry.path.as_str())
                .collect();
            assert_eq!(
                paths,
                [project, linked.to_str().unwrap(), missing.to_str().unwrap()]
            );
            assert_eq!(
                result.worktrees[1].last_modified_at.as_deref(),
                Some("2026-07-15T10:00:00.000Z")
            );
            assert!(result.worktrees[2].is_path_missing);
            assert_eq!(result.worktrees[2].last_modified_at, None);
            assert_eq!(
                serialized(
                    automatic
                        .get_target_candidates(project, None)
                        .await
                        .unwrap()
                ),
                expected[1],
                "targets"
            );
            assert_eq!(
                serialized(get_repo_info(project).await),
                expected[2],
                "repo info"
            );
            tokio::fs::write(root.join(".git/config.worktree"), "[core]\nbare = false\n")
                .await
                .unwrap();
            assert!(
                read_admin_worktree_records(&layout)
                    .await
                    .unwrap()
                    .is_none()
            );
            let mut trace = Vec::new();
            assert_eq!(
                automatic
                    .get_worktrees(project, Some(&mut trace))
                    .await
                    .unwrap(),
                result
            );
            assert!(trace.iter().any(|entry| entry.args[0] == "worktree"));
        })
        .await;
}

#[tokio::test]
async fn worktree_creation_does_not_track_a_remote_base_and_removal_keeps_the_branch() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let root = repo.path().canonicalize().unwrap();
            let project_path = root.to_str().unwrap().to_owned();
            let worktree_path = root.join("feature").to_str().unwrap().to_owned();
            repo.run(&["remote", "add", "origin", "./unused-remote.git"])
                .await;
            repo.run(&["update-ref", "refs/remotes/origin/main", "HEAD"])
                .await;
            repo.run(&["config", "branch.autoSetupMerge", "always"])
                .await;
            let request = CreateWorktreeOptions {
                project_path: project_path.clone(),
                worktree_path: worktree_path.clone(),
                base_ref: Some("origin/main".into()),
                branch: Some("feature".into()),
                new_branch: None,
                detach: None,
            };
            assert_eq!(
                create_worktree(&request).await.unwrap().worktree_path,
                Some(worktree_path.clone())
            );
            assert!(
                repo.run(&["for-each-ref", "--format=%(upstream)", "refs/heads/feature"])
                    .await
                    .trim()
                    .is_empty()
            );
            let mut second = request.clone();
            second.branch = Some("another".into());
            let error = create_worktree(&second).await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "A worktree is already registered at this location."
            );
            assert!(repo.run(&["branch", "--list", "another"]).await.is_empty());
            remove_worktree(&RemoveWorktreeOptions {
                project_path,
                worktree_path: worktree_path.clone(),
                force: None,
            })
            .await
            .unwrap();
            assert!(!std::path::Path::new(&worktree_path).exists());
            assert!(
                repo.run(&["branch", "--list", "feature"])
                    .await
                    .contains("feature")
            );
        })
        .await;
}
