use std::path::PathBuf;
use std::process::Stdio;

use garcon_contract::git::{ConflictAcceptOptions, FileOptions, GitConflictSide, StashRefOptions};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::task::LocalSet;

use super::conflicts::{
    accept_conflict_side, get_conflict_details, get_conflicts, mark_conflict_resolved,
};
use super::discard::discard;
use super::git_domain_error::GitDomainError;
use super::stashes::{apply_stash, drop_stash, get_stashes};
use super::working_tree_comparison::{UntrackedSummaryBudget, summarize_untracked_file};

use super::git_fixture::GitFixture;

fn serialized(value: impl Serialize) -> Value {
    garcon_js::json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn request(method: &str, request: impl Serialize) -> Value {
    json!({ "method": method, "request": serialized(request) })
}

async fn original_operations(base: &str, operations: Vec<Value>) -> Vec<Value> {
    let mut bun = Command::new("bun")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/oracles/git-mutations.ts"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = serde_json::to_vec(&json!({ "base": base, "operations": operations })).unwrap();
    bun.stdin.take().unwrap().write_all(&input).await.unwrap();
    let output = bun.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "original GitRuntime: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut results: Vec<Value> = garcon_js::json::from_slice(&output.stdout).unwrap();
    for result in &mut results {
        if let Some(fields) = result.get_mut("ok").and_then(Value::as_object_mut) {
            assert_eq!(fields.shift_remove("executorId"), Some(json!("local")));
            assert_eq!(
                fields.shift_remove("instanceId"),
                Some(json!("git-mutation-oracle"))
            );
            assert!(
                fields
                    .shift_remove("diagnostics")
                    .is_some_and(|value| value.is_object())
            );
        }
    }
    results
}

async fn stash_fixture() -> GitFixture {
    let repo = GitFixture::with_commit().await;
    for (content, label) in [
        ("one\nfirst change\n", "first\u{1e}subject"),
        ("one\nsecond change\n", "second"),
    ] {
        tokio::fs::write(repo.path().join("a.txt"), content)
            .await
            .unwrap();
        repo.run(&["stash", "push", "-m", label]).await;
    }
    repo
}

#[tokio::test]
async fn stashes_in_the_same_second_act_through_their_own_selectors_and_reject_stale_choices() {
    LocalSet::new()
        .run_until(async {
            let rust = stash_fixture().await;
            let original = stash_fixture().await;
            let rust_path = rust.path().to_str().unwrap();
            let original_path = original.path().to_str().unwrap();
            let initial = get_stashes(rust_path, None).await.unwrap();
            let top = &initial.stashes[0];
            let first = &initial.stashes[1];
            assert_eq!(top.reference, "stash@{0}");
            assert_eq!(first.reference, "stash@{1}");
            assert_eq!(top.date, first.date);
            assert!(first.message.contains("first\u{1e}subject"));
            let operation = |path: &str, reference: &str, hash: &str| StashRefOptions {
                project_path: path.into(),
                stash_ref: reference.into(),
                expected_hash: hash.into(),
            };
            let expected = original_operations(
                original_path,
                vec![
                    request("getStashes", json!({ "projectPath": original_path })),
                    request(
                        "applyStash",
                        operation(original_path, &first.reference, &first.hash),
                    ),
                    request(
                        "dropStash",
                        operation(original_path, &top.reference, &top.hash),
                    ),
                    request(
                        "dropStash",
                        operation(original_path, &top.reference, &top.hash),
                    ),
                    request("getStashes", json!({ "projectPath": original_path })),
                ],
            )
            .await;
            assert_eq!(serialized(&initial), expected[0]["ok"]);
            assert_eq!(
                serde_json::to_string(&initial).unwrap(),
                serde_json::to_string(&expected[0]["ok"]).unwrap(),
                "serialized stash key order",
            );
            let applied = apply_stash(&operation(rust_path, &first.reference, &first.hash), None)
                .await
                .unwrap();
            assert_eq!(serialized(applied), expected[1]["ok"]);
            let dropped = drop_stash(&operation(rust_path, &top.reference, &top.hash), None)
                .await
                .unwrap();
            assert_eq!(serialized(dropped), expected[2]["ok"]);
            let stale = drop_stash(&operation(rust_path, &top.reference, &top.hash), None)
                .await
                .unwrap_err();
            let stale = stale.downcast_ref::<GitDomainError>().unwrap();
            assert_eq!(format!("GIT_{}", stale.code), expected[3]["error"]["code"]);
            assert_eq!(stale.message, expected[3]["error"]["message"]);
            let after = get_stashes(rust_path, None).await.unwrap();
            assert_eq!(serialized(&after), expected[4]["ok"]);
            assert_eq!(after.stashes.len(), 1);
            assert_eq!(after.stashes[0].hash, first.hash);
            let bytes = tokio::fs::read(rust.path().join("a.txt")).await.unwrap();
            assert_eq!(bytes, b"one\nfirst change\n");
            assert_eq!(
                bytes,
                tokio::fs::read(original.path().join("a.txt"))
                    .await
                    .unwrap()
            );
        })
        .await;
}

async fn staged_addition_with_unstaged_edits() -> GitFixture {
    let repo = GitFixture::with_commit().await;
    tokio::fs::write(repo.path().join("added.txt"), "staged\n")
        .await
        .unwrap();
    repo.run(&["add", "added.txt"]).await;
    tokio::fs::write(repo.path().join("added.txt"), "staged\nmodified\n")
        .await
        .unwrap();
    repo
}

#[tokio::test]
async fn discards_only_the_worktree_edit_of_a_staged_addition_like_the_original() {
    LocalSet::new()
        .run_until(async {
            let rust = staged_addition_with_unstaged_edits().await;
            let original = staged_addition_with_unstaged_edits().await;
            assert_eq!(rust.run(&["status", "--porcelain"]).await, "AM added.txt\n");
            let path = |repo: &GitFixture| FileOptions {
                project_path: repo.path().to_str().unwrap().into(),
                file: "added.txt".into(),
            };
            let original_options = path(&original);
            let expected = original_operations(
                &original_options.project_path,
                vec![request("discard", &original_options)],
            )
            .await;
            assert_eq!(
                serialized(discard(&path(&rust)).await.unwrap()),
                expected[0]["ok"]
            );
            assert_eq!(rust.run(&["status", "--porcelain"]).await, "A  added.txt\n");
            assert_eq!(
                rust.run(&["ls-files", "-s", "-z"]).await,
                original.run(&["ls-files", "-s", "-z"]).await
            );
            assert_eq!(
                tokio::fs::read(rust.path().join("added.txt"))
                    .await
                    .unwrap(),
                b"staged\n"
            );
        })
        .await;
}

async fn conflicted_repo() -> GitFixture {
    let repo = GitFixture::with_commit().await;
    let objects = [b"base\n".as_slice(), b"ours\n", b"theirs\n"];
    let mut records = String::from("0 0000000000000000000000000000000000000000\ta.txt\0");
    for (index, bytes) in objects.into_iter().enumerate() {
        let oid = repo
            .git(&["hash-object", "-w", "--stdin"], Some(bytes))
            .await;
        records.push_str(&format!("100644 {} {}\ta.txt\0", oid.trim_end(), index + 1));
    }
    repo.git(
        &["update-index", "-z", "--index-info"],
        Some(records.as_bytes()),
    )
    .await;
    let text = format!("{}\u{2028}<<<<<<< unresolved\n", "x".repeat(65_531));
    tokio::fs::write(repo.path().join("a.txt"), text)
        .await
        .unwrap();
    repo
}

#[tokio::test]
async fn compares_real_conflict_stages_and_resolution_with_the_original() {
    LocalSet::new()
        .run_until(async {
            let rust = conflicted_repo().await;
            let original = conflicted_repo().await;
            let rust_path = rust.path().to_str().unwrap();
            let original_path = original.path().to_str().unwrap();
            let file = |project: &str| FileOptions {
                project_path: project.into(),
                file: "a.txt".into(),
            };
            let accept = |project: &str| ConflictAcceptOptions {
                project_path: project.into(),
                file: "a.txt".into(),
                side: GitConflictSide::Theirs,
            };
            let expected = original_operations(
                original_path,
                vec![
                    request("getConflicts", json!({ "projectPath": original_path })),
                    request("getConflictDetails", file(original_path)),
                    request("markConflictResolved", file(original_path)),
                    request("acceptConflictSide", accept(original_path)),
                    request("getConflicts", json!({ "projectPath": original_path })),
                ],
            )
            .await;

            let listing = serialized(get_conflicts(rust_path, None).await.unwrap());
            assert_eq!(listing, expected[0]["ok"]);
            assert_eq!(listing["conflicts"][0]["status"], "UU");
            let details = serialized(get_conflict_details(&file(rust_path), None).await.unwrap());
            assert_eq!(details, expected[1]["ok"]);
            assert_eq!(details["theirs"]["content"], "theirs\n");
            let index_before = rust.run(&["ls-files", "-u", "-z"]).await;
            let unresolved = mark_conflict_resolved(&file(rust_path), None)
                .await
                .unwrap_err();
            let unresolved = unresolved.downcast_ref::<GitDomainError>().unwrap();
            assert_eq!(
                format!("GIT_{}", unresolved.code),
                expected[2]["error"]["code"]
            );
            assert_eq!(unresolved.message, expected[2]["error"]["message"]);
            assert_eq!(rust.run(&["ls-files", "-u", "-z"]).await, index_before);
            assert_eq!(
                serialized(
                    accept_conflict_side(&accept(rust_path), None)
                        .await
                        .unwrap()
                ),
                expected[3]["ok"]
            );
            assert_eq!(
                serialized(get_conflicts(rust_path, None).await.unwrap()),
                expected[4]["ok"]
            );
            assert_eq!(rust.run(&["show", ":a.txt"]).await, "theirs\n");
            assert_eq!(
                rust.run(&["ls-files", "-s", "-z"]).await,
                original.run(&["ls-files", "-s", "-z"]).await
            );
        })
        .await;
}

#[tokio::test]
async fn counts_unterminated_untracked_lines_and_honors_the_remaining_budget() {
    let fixture = GitFixture::with_commit().await;
    let project = fixture.path().to_str().unwrap();
    tokio::fs::write(fixture.path().join("plain"), b"first\nlast")
        .await
        .unwrap();
    tokio::fs::write(fixture.path().join("binary"), b"\0")
        .await
        .unwrap();
    let mut budget = UntrackedSummaryBudget {
        remaining_bytes: 10,
    };
    let plain = summarize_untracked_file(project, "plain", &mut budget, None)
        .await
        .unwrap();
    assert_eq!(plain.additions, 2);
    assert!(plain.stats_known);
    assert_eq!(budget.remaining_bytes, 0);
    let uncounted = summarize_untracked_file(project, "plain", &mut budget, None)
        .await
        .unwrap();
    assert!(!uncounted.stats_known);
    let binary = summarize_untracked_file(project, "binary", &mut budget, None)
        .await
        .unwrap();
    assert!(binary.is_binary);
}
