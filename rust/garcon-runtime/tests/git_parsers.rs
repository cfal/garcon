//! Replays the original's pure Git parsers and exercises their live inputs.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::process::Stdio;

use garcon_base::errors::{ErrorInput, NamedError};
use garcon_cases::{CaseError, javascript_number, markers, replay, text, unknown};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::task::LocalSet;

#[path = "support/git_fixture.rs"]
mod git_fixture;

use garcon_runtime::git::comparison_errors::{
    is_expected_missing_git_result, is_unresolved_revision, needs_revision_failure_diagnostics,
};
use garcon_runtime::git::diff_file_list::{
    parse_name_status_z, parse_numstat_z, parse_unmerged_paths,
};
use garcon_runtime::git::git_domain_error::GitDomainError;
use garcon_runtime::git::git_error_classifier::classify_git_error;
use garcon_runtime::git::log_records::nul_records;
use garcon_runtime::git::pathspecs::{
    chunk_git_pathspecs, exact_git_pathspecs, literal_git_pathspec,
};
use garcon_runtime::git::porcelain_status::{
    change_kind_for_status, has_index_change, has_work_tree_change, parse_porcelain_v1_z,
};
use garcon_runtime::git::ref_validation::{
    assert_existing_commit_ref, assert_safe_branch_name, assert_safe_ref, assert_safe_remote_name,
};
use garcon_runtime::git::types::GitProcessError;
use garcon_runtime::git::worktree_layout::{parse_worktree_layout_probe, probe_worktree_layout};
use garcon_runtime::git::worktree_porcelain::{
    parse_worktree_porcelain_lines, parse_worktree_porcelain_z, read_porcelain_worktree_records,
};
use garcon_runtime::git::worktree_record::{WorktreeRecord, compare_worktree_paths};
use git_fixture::GitFixture;

const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/git");

fn to_value(value: impl Serialize) -> Result<Value, CaseError> {
    let json = serde_json::to_string(&value)
        .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_str(&json).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn arg<T: DeserializeOwned>(function: &str, argument: Option<&Value>) -> Result<T, CaseError> {
    serde_json::from_value(unknown(function, argument)?.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn domain_error(error: GitDomainError) -> CaseError {
    CaseError::new("GitDomainError", error.message).with_property("code", error.code)
}

fn process_error(input: &Value) -> GitProcessError {
    let (message, fields) = if markers::kind(input) == Some("error") {
        (
            input["message"].as_str().unwrap_or_default(),
            &input["properties"],
        )
    } else {
        ("", input)
    };
    GitProcessError {
        message: message.into(),
        code: fields["code"]
            .as_i64()
            .and_then(|code| code.try_into().ok())
            .or_else(|| {
                fields["code"]
                    .as_f64()
                    .filter(|code| {
                        code.fract() == 0.0 && *code >= i32::MIN as f64 && *code <= i32::MAX as f64
                    })
                    .map(|code| code as i32)
            }),
        stdout: fields["stdout"].as_str().unwrap_or_default().into(),
        stderr: fields["stderr"].as_str().unwrap_or_default().into(),
        timed_out: fields["timedOut"].as_bool(),
        aborted: fields["aborted"].as_bool(),
    }
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let required =
        |index| text(function, args.get(index))?.ok_or_else(|| CaseError::unhandled(function));
    match function {
        "parseNumstatZ" => to_value(parse_numstat_z(required(0)?)),
        "parseNameStatusZ" => to_value(parse_name_status_z(
            required(0)?,
            &arg(function, args.get(1))?,
        )),
        "parseUnmergedPaths" => Ok(markers::marker(
            "set",
            to_value(parse_unmerged_paths(required(0)?))?,
        )),
        "parsePorcelainV1Z" => to_value(parse_porcelain_v1_z(required(0)?)),
        "changeKindForStatus" => to_value(change_kind_for_status(required(0)?)),
        "hasIndexChange" => Ok(json!(has_index_change(required(0)?))),
        "hasWorkTreeChange" => Ok(json!(has_work_tree_change(required(0)?))),
        "literalGitPathspec" => Ok(json!(literal_git_pathspec(required(0)?))),
        "exactGitPathspecs" => Ok(json!(exact_git_pathspecs(&arg::<Vec<String>>(
            function,
            args.first()
        )?))),
        "chunkGitPathspecs" => Ok(json!(chunk_git_pathspecs(&arg::<Vec<String>>(
            function,
            args.first()
        )?))),
        "parseWorktreePorcelainLines" => to_value(parse_worktree_porcelain_lines(required(0)?)),
        "parseWorktreePorcelainZ" => to_value(parse_worktree_porcelain_z(required(0)?)),
        "parseWorktreeLayoutProbe" => to_value(parse_worktree_layout_probe(required(0)?)),
        "compareWorktreePaths" => {
            let left: WorktreeRecord = arg(function, args.first())?;
            let right: WorktreeRecord = arg(function, args.get(1))?;
            Ok(json!(match compare_worktree_paths(&left, &right) {
                Ordering::Less => -1,
                Ordering::Equal => 0,
                Ordering::Greater => 1,
            }))
        }
        "assertSafeRef" => assert_safe_ref(required(0)?, required(1)?)
            .map(|()| markers::undefined())
            .map_err(domain_error),
        "assertSafeRemoteName" => {
            assert_safe_remote_name(required(0)?, text(function, args.get(1))?)
                .map(|()| markers::undefined())
                .map_err(domain_error)
        }
        "nulRecords" => {
            let width = javascript_number(function, args.get(1))? as usize;
            to_value(nul_records(required(0)?, width, required(2)?).map_err(domain_error)?)
        }
        "classifyGitError" => {
            if let Some(value) = args
                .first()
                .filter(|value| markers::kind(value) == Some("error"))
            {
                let error = NamedError {
                    name: value["name"]
                        .as_str()
                        .ok_or_else(|| CaseError::unhandled(function))?
                        .into(),
                    message: text(function, value.get("message"))?
                        .ok_or_else(|| CaseError::unhandled(function))?
                        .into(),
                    code: value["properties"]["code"].as_str().map(str::to_owned),
                };
                to_value(classify_git_error(ErrorInput::Diagnostic(&error)))
            } else {
                let value = unknown(function, args.first())?;
                to_value(classify_git_error(ErrorInput::Json(&value)))
            }
        }
        "isExpectedMissingGitResult"
        | "isUnresolvedRevision"
        | "needsRevisionFailureDiagnostics" => {
            let error = process_error(args.first().unwrap_or(&Value::Null));
            Ok(json!(match function {
                "isExpectedMissingGitResult" => is_expected_missing_git_result(&error),
                "isUnresolvedRevision" => is_unresolved_revision(&error),
                _ => needs_revision_failure_diagnostics(&error),
            }))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

macro_rules! parser_cases {
    ($($name:ident: $directory:literal),+ $(,)?) => { $(
        #[test]
        fn $name() {
            replay(PathBuf::from(CASES).join($directory), dispatch);
        }
    )+ };
}

parser_cases! {
    recorded_comparison_errors_match: "comparison-errors",
    recorded_diff_file_list_matches: "diff-file-list",
    recorded_git_error_classifier_matches: "git-error-classifier",
    recorded_log_records_match: "log-records",
    recorded_pathspecs_match: "pathspecs",
    recorded_porcelain_status_matches: "porcelain-status",
    recorded_ref_validation_matches: "ref-validation",
    recorded_worktree_layout_matches: "worktree-layout",
    recorded_worktree_porcelain_matches: "worktree-porcelain",
    recorded_worktree_record_matches: "worktree-record",
}

#[test]
fn inherited_function_statuses_that_the_recorder_cannot_deliver_use_the_modified_fallback() {
    use garcon_contract::git::GitChangeKind;
    for status in ["constructor", "toString", "hasOwnProperty"] {
        assert_eq!(change_kind_for_status(status), GitChangeKind::Modified);
    }
}

#[test]
fn numstat_lists_numeric_path_keys_first_in_numeric_order() {
    let stats = parse_numstat_z(concat!(
        "1\t0\tz\0",
        "1\t0\t10\0",
        "1\t0\t02\0",
        "1\t0\t2\0"
    ));
    assert_eq!(
        stats.keys().map(String::as_str).collect::<Vec<_>>(),
        ["2", "10", "z", "02"],
    );
}

#[tokio::test]
async fn ref_checks_and_worktree_reads_use_live_git() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let path = repo.path().canonicalize().unwrap();
            let path = path.to_str().unwrap();
            assert!(
                assert_existing_commit_ref(path, "HEAD", "base", None)
                    .await
                    .is_ok()
            );
            let error = assert_existing_commit_ref(path, "no-such-branch", "base", None)
                .await
                .unwrap_err();
            assert_eq!(
                (error.code.as_str(), error.message.as_str()),
                ("INVALID_INPUT", "Invalid base ref.")
            );
            assert!(
                assert_safe_branch_name(path, "topic/branch", None, None)
                    .await
                    .is_ok()
            );
            let error = assert_safe_branch_name(path, "bad~name", None, None)
                .await
                .unwrap_err();
            assert_eq!(
                (error.code.as_str(), error.message.as_str()),
                ("INVALID_INPUT", "Invalid branch name.")
            );

            let layout = probe_worktree_layout(path, None).await.unwrap();
            assert_eq!(layout.worktree_root, path);
            assert_eq!(
                layout.common_dir,
                repo.path()
                    .canonicalize()
                    .unwrap()
                    .join(".git")
                    .to_str()
                    .unwrap()
            );
            let records = read_porcelain_worktree_records(path, None).await.unwrap();
            assert_eq!(
                records,
                [WorktreeRecord {
                    path: path.into(),
                    branch: "main".into(),
                    name: "main".into(),
                    is_main: true
                }]
            );
        })
        .await;
}

#[tokio::test]
async fn real_numstat_keeps_a_legal_proto_path_as_an_own_key() {
    let repo = GitFixture::with_commit().await;
    tokio::fs::write(repo.path().join("__proto__"), "one\ntwo\n")
        .await
        .unwrap();
    tokio::fs::write(repo.path().join("constructor"), "other\n")
        .await
        .unwrap();
    repo.run(&["add", "--", "__proto__", "constructor"]).await;
    let numstat = repo.run(&["diff", "--cached", "--numstat", "-z"]).await;
    let name_status = repo.run(&["diff", "--cached", "--name-status", "-z"]).await;
    let stats = parse_numstat_z(&numstat);
    let mut bun = Command::new("bun")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/git_parser_oracle.ts"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input =
        serde_json::to_vec(&json!({"numstat": numstat, "nameStatus": name_status})).unwrap();
    bun.stdin.take().unwrap().write_all(&input).await.unwrap();
    let result = bun.wait_with_output().await.unwrap();
    assert!(
        result.status.success(),
        "Bun parser oracle: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let original: Value = garcon_js::json::from_slice(&result.stdout).unwrap();

    let mut stats_as_json = to_value(&stats).unwrap();
    let owned_entry = stats_as_json
        .as_object_mut()
        .unwrap()
        .shift_remove("__proto__");
    assert_eq!(owned_entry, Some(json!({"additions": 2, "deletions": 0})));
    assert_eq!(stats_as_json, original["stats"]);
    assert_eq!(
        to_value(parse_name_status_z(&name_status, &stats)).unwrap(),
        original["files"]
    );
}
