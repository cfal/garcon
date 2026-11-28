use std::process::Stdio;
use std::rc::Rc;

use garcon_contract::git::{
    GitCommitFileStatus, GitComparisonEndpointSide, GitComparisonFreshnessOptions,
    GitComparisonFreshnessResponse, GitComparisonFreshnessToExpectation, GitComparisonMode,
    GitComparisonRevisionEndpoint, GitComparisonRevisionExpectation, GitComparisonRevisionKind,
    GitComparisonSnapshotOptions, GitComparisonSnapshotResponse, GitComparisonToEndpoint,
    GitReviewBodyState,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, process::Command, task::LocalSet};

use super::comparison::{ComparisonOperations, GIT_EMPTY_TREE};
use super::git_fixture::GitFixture;
use super::review_diff_batch::GitReviewDiffBatchContext;
use super::review_document_registry::GitReviewDocumentRegistry;
use super::temporary_index::TemporaryGitIndexEnvironment;

async fn reference(input: &Value) -> String {
    let mut child = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/git-comparison.ts"
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
        .write_all(&serde_json::to_vec(input).unwrap())
        .await
        .unwrap();
    let result = child.wait_with_output().await.unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim_end().into()
}

#[tokio::test]
async fn compares_live_revisions_working_tree_and_endpoint_freshness_with_bun() {
    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        let path = repo.path().to_str().unwrap();
        let base = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        repo.run(&["switch", "-c", "left"]).await;
        tokio::fs::write(repo.path().join("left.txt"), "only on left\n").await.unwrap();
        repo.run(&["add", "left.txt"]).await;
        repo.run(&["commit", "-m", "left change"]).await;
        repo.run(&["switch", "main"]).await;
        repo.run(&["mv", "a.txt", "renamed.txt"]).await;
        tokio::fs::write(repo.path().join("blob.bin"), b"\0old\n").await.unwrap();
        repo.run(&["add", "blob.bin"]).await;
        repo.run(&["commit", "-m", "main change"]).await;
        let head = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        tokio::fs::write(repo.path().join("blob.bin"), b"\0new\n").await.unwrap();
        tokio::fs::write(repo.path().join("unicode-\u{00e9}.txt"), "alpha\nbeta").await.unwrap();
        tokio::fs::write(repo.path().join("renamed.txt"), "one\nnew worktree line\n").await.unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("renamed.txt", repo.path().join("untracked-link")).unwrap();

        let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
        let operations = ComparisonOperations::new(registry, None);
        let environment = TemporaryGitIndexEnvironment::default();
        let context = GitReviewDiffBatchContext {
            trace: None, signal: None, metrics: None, temporary_index: &environment,
        };
        let snap = |from: &str, to: GitComparisonToEndpoint, mode| GitComparisonSnapshotOptions {
            project_path: path.into(), from: GitComparisonRevisionEndpoint {
                kind: GitComparisonRevisionKind::Revision, revision: from.into(),
            }, to, mode, context: None, body_candidate_count: Some(2),
        };
        let revision = |revision: &str| GitComparisonToEndpoint::Revision { revision: revision.into() };
        let snapshots = [
            snap("left", revision("HEAD"), GitComparisonMode::Direct),
            snap("left", revision("HEAD"), GitComparisonMode::MergeBase),
            snap("HEAD", GitComparisonToEndpoint::WorkingTree, GitComparisonMode::Direct),
            snap(GIT_EMPTY_TREE, revision("HEAD"), GitComparisonMode::MergeBase),
            snap("left", revision("no-such-ref"), GitComparisonMode::Direct),
        ];
        let fresh = |from: &str, hash: &str, to| GitComparisonFreshnessOptions {
            project_path: path.into(), from: GitComparisonRevisionExpectation {
                kind: GitComparisonRevisionKind::Revision, revision: from.into(), hash: hash.into(),
            }, to,
        };
        let freshness = [
            fresh("HEAD", &base, GitComparisonFreshnessToExpectation::Revision { revision: "HEAD".into(), hash: head }),
            fresh("HEAD", &base, GitComparisonFreshnessToExpectation::WorkingTree { fingerprint: "earlier-observation".into() }),
            fresh("no-such-ref", &base, GitComparisonFreshnessToExpectation::WorkingTree { fingerprint: "earlier-observation".into() }),
        ];
        let mut got_snapshots = Vec::new();
        for request in &snapshots {
            let mut result = operations.get_comparison_snapshot(request, &context).await.unwrap();
            if let GitComparisonSnapshotResponse::Ready(ref mut ready) = result {
                assert_eq!(uuid::Uuid::parse_str(&ready.document_id).unwrap().get_version_num(), 4);
                ready.document_id = "<document>".into();
            }
            got_snapshots.push(result);
        }
        let GitComparisonSnapshotResponse::Ready(direct) = &got_snapshots[0] else { panic!("expected ready direct comparison"); };
        assert!(direct.files.iter().any(|file| file.status == GitCommitFileStatus::Renamed
            && file.original_path.as_deref() == Some("a.txt")));
        let GitComparisonSnapshotResponse::Ready(merge_base) = &got_snapshots[1] else { panic!("expected ready merge-base comparison"); };
        assert_eq!(merge_base.effective_from_hash, base);
        let GitComparisonSnapshotResponse::Ready(working) = &got_snapshots[2] else { panic!("expected ready worktree comparison"); };
        let untracked = working.files.iter().find(|file| file.path.starts_with("unicode-")).unwrap();
        assert_eq!(untracked.raw_status, "?");
        assert_eq!(untracked.additions.0, 2.0);
        assert!(working.files.iter().any(|file| file.body_state == GitReviewBodyState::Binary));
        assert!(matches!(got_snapshots[3], GitComparisonSnapshotResponse::NoMergeBase { .. }));
        assert!(matches!(got_snapshots[4], GitComparisonSnapshotResponse::NotFound { endpoint: GitComparisonEndpointSide::To, .. }));
        let mut got_freshness = Vec::new();
        for request in &freshness {
            got_freshness.push(operations.get_comparison_freshness(request, &context).await.unwrap());
        }
        assert!(matches!(&got_freshness[1], GitComparisonFreshnessResponse::Ready { changed_endpoints, .. }
            if changed_endpoints == &[GitComparisonEndpointSide::From, GitComparisonEndpointSide::To]));
        assert!(matches!(got_freshness[2], GitComparisonFreshnessResponse::NotFound { endpoint: GitComparisonEndpointSide::From, .. }));
        #[derive(Serialize)]
        struct Output {
            snapshots: Vec<GitComparisonSnapshotResponse>,
            freshness: Vec<GitComparisonFreshnessResponse>,
        }
        assert_eq!(
            serde_json::to_string(&Output { snapshots: got_snapshots, freshness: got_freshness }).unwrap(),
            reference(&json!({ "snapshots": snapshots, "freshness": freshness })).await,
        );
    }).await;
}
