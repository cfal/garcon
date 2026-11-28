use std::cell::Cell;
use std::process::Stdio;
use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::path_boundary::{
    ProjectBoundaryError, assert_real_within_base, is_project_boundary_error,
};
use garcon_contract::git::{
    GIT_REVIEW_DOCUMENT_LIMITS, GitCommitFileStatus, GitComparisonEndpointSide,
    GitComparisonFreshnessOptions, GitComparisonFreshnessResponse,
    GitComparisonFreshnessToExpectation, GitComparisonMode, GitComparisonRevisionEndpoint,
    GitComparisonRevisionExpectation, GitComparisonRevisionKind, GitComparisonSnapshotOptions,
    GitComparisonSnapshotResponse, GitComparisonToEndpoint, GitReviewBodyState,
    GitReviewLimitReason,
};
use garcon_interface::resources::ExecutorResult;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, process::Command, task::LocalSet};

use super::comparison::{ComparisonOperations, GIT_EMPTY_TREE};
use super::git_domain_error::GitDomainError;
use super::git_fixture::GitFixture;
use super::review_diff_batch::GitReviewDiffBatchContext;
use super::review_document_registry::GitReviewDocumentRegistry;
use super::temporary_index::TemporaryGitIndexEnvironment;
use super::worktrees::ProjectPathAllowed;

#[derive(Serialize)]
struct OracleResults<S, F> {
    snapshots: S,
    freshness: F,
}

fn snapshots_wire(snapshots: &[GitComparisonSnapshotResponse]) -> String {
    serde_json::to_string(&OracleResults {
        snapshots,
        freshness: [] as [GitComparisonFreshnessResponse; 0],
    })
    .unwrap()
}

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

fn operations() -> ComparisonOperations {
    ComparisonOperations::new(
        Rc::new(GitReviewDocumentRegistry::new(Default::default())),
        None,
    )
}

fn context(environment: &TemporaryGitIndexEnvironment) -> GitReviewDiffBatchContext<'_> {
    GitReviewDiffBatchContext {
        trace: None,
        signal: None,
        metrics: None,
        temporary_index: environment,
    }
}

fn working(project: &str) -> GitComparisonSnapshotOptions {
    GitComparisonSnapshotOptions {
        project_path: project.into(),
        from: GitComparisonRevisionEndpoint {
            kind: GitComparisonRevisionKind::Revision,
            revision: "HEAD".into(),
        },
        to: GitComparisonToEndpoint::WorkingTree,
        mode: GitComparisonMode::Direct,
        context: None,
        body_candidate_count: None,
    }
}

fn normalize_document(result: &mut GitComparisonSnapshotResponse) {
    if let GitComparisonSnapshotResponse::Ready(ready) = result {
        assert_eq!(
            uuid::Uuid::parse_str(&ready.document_id)
                .unwrap()
                .get_version_num(),
            4
        );
        ready.document_id = "<document>".into();
    }
}

#[tokio::test]
async fn validates_working_tree_mode_resolved_hashes_and_canonical_repository_boundary() {
    struct AllowedRoot(String);
    #[async_trait(?Send)]
    impl ProjectPathAllowed for AllowedRoot {
        async fn assert_project_path_allowed(&self, path: &str) -> ExecutorResult<String> {
            Ok(assert_real_within_base(&self.0, path).await?)
        }
    }

    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        let path = repo.path().to_str().unwrap();
        let env = TemporaryGitIndexEnvironment::default();
        let ctx = context(&env);
        let operations = operations();
        let mut snapshot = working(path);
        snapshot.mode = GitComparisonMode::MergeBase;
        let error = operations.get_comparison_snapshot(&snapshot, &ctx).await.unwrap_err();
        let error = error.downcast_ref::<GitDomainError>().unwrap();
        assert_eq!(error.code, "INVALID_INPUT");
        let snapshots = [json!({ "code": error.code, "message": error.message })];
        let head = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        let mut requests = Vec::new();
        let mut errors = Vec::new();
        for (side, from, to) in [
            ("from", "HEAD", head.as_str()), ("to", head.as_str(), "HEAD"),
        ] {
            let request = GitComparisonFreshnessOptions {
                project_path: path.into(),
                from: GitComparisonRevisionExpectation {
                    kind: GitComparisonRevisionKind::Revision, revision: "HEAD".into(), hash: from.into(),
                },
                to: GitComparisonFreshnessToExpectation::Revision { revision: "HEAD".into(), hash: to.into() },
            };
            let error = operations.get_comparison_freshness(&request, &ctx).await.unwrap_err();
            let error = error.downcast_ref::<GitDomainError>().unwrap();
            assert_eq!(error.code, "INVALID_INPUT");
            assert_eq!(error.message, format!("{side}.hash must be a resolved Git object hash."));
            errors.push(json!({ "code": error.code, "message": error.message }));
            requests.push(request);
        }
        assert_eq!(
            serde_json::to_string(&json!({ "snapshots": snapshots, "freshness": errors })).unwrap(),
            reference(&json!({ "snapshots": [snapshot], "freshness": requests })).await,
        );

        let nested = repo.path().join("allowed");
        tokio::fs::create_dir(&nested).await.unwrap();
        let nested = nested.to_str().unwrap();
        let scoped = ComparisonOperations::new(
            Rc::new(GitReviewDocumentRegistry::new(Default::default())),
            Some(Rc::new(AllowedRoot(nested.into()))),
        );
        let request = working(nested);
        let error = scoped.get_comparison_snapshot(&request, &ctx).await.unwrap_err();
        assert!(is_project_boundary_error(error.as_ref()));
        assert_eq!(
            serde_json::to_string(&json!({
                "snapshots": [{ "code": ProjectBoundaryError::ERROR_CODE, "message": error.to_string() }],
                "freshness": [],
            })).unwrap(),
            reference(&json!({ "snapshots": [request], "allowedRoot": nested })).await,
        );
    }).await;
}

#[tokio::test]
async fn retries_once_then_reports_two_unstable_working_tree_observations() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let path = repo.path().to_str().unwrap();
            let file = repo.path().join("a.txt");
            let env = TemporaryGitIndexEnvironment::default();
            let request = working(path);
            for edits in [
                &["second edit with different length\n"][..],
                &["second edit with different length\n", "third edit\n"][..],
            ] {
                tokio::fs::write(&file, "first edit\n").await.unwrap();
                let attempts = Rc::new(Cell::new(0));
                let mut operations = operations();
                operations.before_worktree_validation = Some(Box::new({
                    let (file, attempts) = (file.clone(), attempts.clone());
                    move || {
                        let index = attempts.get();
                        attempts.set(index + 1);
                        if let Some(contents) = edits.get(index) {
                            std::fs::write(&file, contents).unwrap();
                        }
                    }
                }));
                let mut snapshot = operations
                    .get_comparison_snapshot(&request, &context(&env))
                    .await
                    .unwrap();
                assert_eq!(attempts.get(), 2);
                let oracle = if edits.len() == 1 {
                    let GitComparisonSnapshotResponse::Ready(ref ready) = snapshot else {
                        panic!("expected a stable second snapshot: {snapshot:?}");
                    };
                    assert_eq!(ready.files.len(), 1);
                    assert_eq!(ready.files[0].path, "a.txt");
                    assert_eq!(ready.files[0].additions.0, 1.0);
                    normalize_document(&mut snapshot);
                    // The fingerprint includes ctime, so compare against this exact final tree.
                    json!({ "snapshots": [&request] })
                } else {
                    assert!(matches!(
                        snapshot,
                        GitComparisonSnapshotResponse::WorkingTreeChanging { .. }
                    ));
                    tokio::fs::write(&file, "first edit\n").await.unwrap();
                    json!({ "snapshots": [&request], "validationEdits": edits })
                };
                assert_eq!(snapshots_wire(&[snapshot]), reference(&oracle).await);
            }
        })
        .await;
}

#[tokio::test]
async fn reports_unrelated_revision_histories_and_limits_conflicted_binary_and_large_paths() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let path = repo.path().to_str().unwrap();
            repo.run(&["switch", "--orphan", "unrelated"]).await;
            tokio::fs::write(repo.path().join("unrelated.txt"), "unrelated\n")
                .await
                .unwrap();
            repo.run(&["add", "--", "unrelated.txt"]).await;
            repo.run(&["commit", "-m", "unrelated root"]).await;
            repo.run(&["switch", "main"]).await;
            let mut conflict = format!("0 {}\ta.txt\n", "0".repeat(40));
            for (stage, data) in [(1, "base\n"), (2, "ours\n"), (3, "theirs\n")] {
                let hash = repo
                    .git(&["hash-object", "-w", "--stdin"], Some(data.as_bytes()))
                    .await;
                conflict.push_str(&format!("100644 {} {stage}\ta.txt\n", hash.trim()));
            }
            repo.git(&["update-index", "--index-info"], Some(conflict.as_bytes()))
                .await;
            tokio::fs::write(repo.path().join("a.txt"), "conflicted contents\n")
                .await
                .unwrap();
            tokio::fs::write(repo.path().join("binary.dat"), b"\0binary\n")
                .await
                .unwrap();
            tokio::fs::write(
                repo.path().join("oversized.txt"),
                vec![b'a'; GIT_REVIEW_DOCUMENT_LIMITS.max_file_patch_bytes + 1],
            )
            .await
            .unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink("a.txt", repo.path().join("linked.txt")).unwrap();

            let env = TemporaryGitIndexEnvironment::default();
            let ctx = context(&env);
            let operations = operations();
            let request = working(path);
            let mut unrelated = working(path);
            unrelated.to = GitComparisonToEndpoint::Revision {
                revision: "unrelated".into(),
            };
            unrelated.mode = GitComparisonMode::MergeBase;
            let no_base = operations
                .get_comparison_snapshot(&unrelated, &ctx)
                .await
                .unwrap();
            assert!(matches!(
                no_base,
                GitComparisonSnapshotResponse::NoMergeBase { .. }
            ));

            let mut snapshot = operations
                .get_comparison_snapshot(&request, &ctx)
                .await
                .unwrap();
            let GitComparisonSnapshotResponse::Ready(ref ready) = snapshot else {
                panic!("expected ready working tree: {snapshot:?}");
            };
            let check = |path, state, reason| {
                let entry = ready.files.iter().find(|entry| entry.path == path).unwrap();
                assert_eq!(entry.body_state, state, "{path}");
                assert_eq!(entry.limit_reason, Some(reason), "{path}");
                assert!(
                    !ready
                        .first_body_candidates
                        .iter()
                        .any(|candidate| candidate == path)
                );
            };
            check(
                "a.txt",
                GitReviewBodyState::TooLarge,
                GitReviewLimitReason::UnsupportedFileKind,
            );
            check(
                "binary.dat",
                GitReviewBodyState::Binary,
                GitReviewLimitReason::Binary,
            );
            check(
                "oversized.txt",
                GitReviewBodyState::TooLarge,
                GitReviewLimitReason::FileTooManyBytes,
            );
            #[cfg(unix)]
            check(
                "linked.txt",
                GitReviewBodyState::TooLarge,
                GitReviewLimitReason::UnsupportedFileKind,
            );
            normalize_document(&mut snapshot);
            assert_eq!(
                snapshots_wire(&[no_base, snapshot]),
                reference(&json!({ "snapshots": [unrelated, request] })).await,
            );
        })
        .await;
}

#[tokio::test]
async fn bounds_untracked_line_counting_in_path_order() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let path = repo.path().to_str().unwrap();
            for name in ["two.txt", "three.txt", "one.txt"] {
                tokio::fs::write(repo.path().join(name), vec![b'a'; 4_000_000])
                    .await
                    .unwrap();
            }
            let env = TemporaryGitIndexEnvironment::default();
            let request = working(path);
            let mut result = operations()
                .get_comparison_snapshot(&request, &context(&env))
                .await
                .unwrap();
            let GitComparisonSnapshotResponse::Ready(ref ready) = result else {
                panic!("expected ready working tree: {result:?}");
            };
            assert_eq!(
                ready
                    .files
                    .iter()
                    .map(|entry| (entry.path.as_str(), entry.additions.0, entry.stats_known))
                    .collect::<Vec<_>>(),
                [
                    ("one.txt", 1.0, None),
                    ("three.txt", 1.0, None),
                    ("two.txt", 0.0, Some(false))
                ],
            );
            normalize_document(&mut result);
            assert_eq!(
                snapshots_wire(&[result]),
                reference(&json!({ "snapshots": [request] })).await,
            );
        })
        .await;
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
        assert_eq!(
            serde_json::to_string(&OracleResults { snapshots: got_snapshots, freshness: got_freshness }).unwrap(),
            reference(&json!({ "snapshots": snapshots, "freshness": freshness })).await,
        );
    }).await;
}
