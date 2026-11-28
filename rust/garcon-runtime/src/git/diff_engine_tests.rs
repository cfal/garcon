use std::cell::RefCell;
use std::rc::Rc;

use garcon_cases::{CaseError, replay, text};
use garcon_contract::git::{
    GitLineSelection, GitReviewBodyPurpose, GitReviewDocumentFileBodiesOptions,
    GitReviewDocumentFileBodiesResponse, GitReviewMode, GitStageMode, GitWorkbenchSnapshotOptions,
    GitWorkbenchSnapshotResponse, StageHunkOptions, StageSelectionOptions,
};
use garcon_contract::git_execution::{
    ExecutionStageHunkOptions, ExecutionStageSelectionOptions, GitReviewDocumentRef,
    GitSelectionProof,
};
use garcon_js::OptionalNullable;
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, process::Command, task::LocalSet};

use super::diff_engine::{DiffEngine, not_repository_snapshot};
use super::git_domain_error::GitDomainError;
use super::git_fixture::GitFixture;
use super::review_diff_batch::GitReviewDiffBatchContext;
use super::review_document_registry::GitReviewDocumentRegistry;
use super::review_document_service::GitReviewDocumentOperations;
use super::temporary_index::TemporaryGitIndexEnvironment;
use super::types::GitCommandTrace;

#[test]
fn recorded_diff_engine_matches() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/git/diff-engine"),
        |function, args| match function {
            "notRepositorySnapshot" => {
                let path =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                let bytes = serde_json::to_vec(&not_repository_snapshot(path)).unwrap();
                Ok(garcon_js::json::from_slice(&bytes).unwrap())
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

async fn reference(input: &Value) -> String {
    use std::process::Stdio;

    let mut child = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/git-workbench.ts"
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
async fn returns_tree_and_review_summary_in_bun_order_for_both_directory_facet_orders() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let root = repo.path().to_str().unwrap();
            let empty = GitFixture::empty();
            for dir in ["staged-first", "unstaged-first"] {
                tokio::fs::create_dir(repo.path().join(dir)).await.unwrap();
                for file in ["a.txt", "z.txt"] {
                    tokio::fs::write(repo.path().join(dir).join(file), "before\n")
                        .await
                        .unwrap();
                }
            }
            tokio::fs::write(repo.path().join("deleted.txt"), "delete me\n")
                .await
                .unwrap();
            tokio::fs::write(repo.path().join("blob.bin"), b"\x00old\n")
                .await
                .unwrap();
            repo.run(&[
                "add",
                "--",
                "staged-first",
                "unstaged-first",
                "deleted.txt",
                "blob.bin",
            ])
            .await;
            repo.run(&["commit", "-m", "add review sources"]).await;
            tokio::fs::remove_file(repo.path().join("deleted.txt"))
                .await
                .unwrap();
            tokio::fs::write(repo.path().join("blob.bin"), b"\x00new\n")
                .await
                .unwrap();
            tokio::fs::write(repo.path().join("new file.txt"), "new\n")
                .await
                .unwrap();
            for dir in ["staged-first", "unstaged-first"] {
                for file in ["a.txt", "z.txt"] {
                    tokio::fs::write(repo.path().join(dir).join(file), "changed\nmore\n")
                        .await
                        .unwrap();
                }
            }
            repo.run(&["add", "--", "staged-first/a.txt", "unstaged-first/z.txt"])
                .await;

            let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
            let engine = DiffEngine::new(registry);
            let environment = TemporaryGitIndexEnvironment::default();
            let trace = RefCell::new(Vec::<GitCommandTrace>::new());
            let context = GitReviewDiffBatchContext {
                trace: Some(&trace),
                signal: None,
                metrics: None,
                temporary_index: &environment,
            };
            let requests = [
                GitWorkbenchSnapshotOptions {
                    project_path: root.into(),
                    mode: GitReviewMode::Working,
                    context: 3,
                    selected_file: OptionalNullable::some("new file.txt".into()),
                    body_candidate_count: Some(2),
                },
                GitWorkbenchSnapshotOptions {
                    project_path: root.into(),
                    mode: GitReviewMode::Staged,
                    context: 0,
                    selected_file: OptionalNullable::NULL,
                    body_candidate_count: Some(0),
                },
                GitWorkbenchSnapshotOptions {
                    project_path: empty.path().to_str().unwrap().into(),
                    mode: GitReviewMode::Working,
                    context: 3,
                    selected_file: OptionalNullable::ABSENT,
                    body_candidate_count: None,
                },
            ];
            let mut outputs = Vec::new();
            for request in &requests {
                let mut snapshot = engine
                    .get_workbench_snapshot(request, &context)
                    .await
                    .unwrap();
                if let GitWorkbenchSnapshotResponse::Ready(ref mut ready) = snapshot {
                    assert_eq!(ready.snapshot_id, ready.review_summary.document_id);
                    assert_eq!(
                        uuid::Uuid::parse_str(&ready.snapshot_id)
                            .unwrap()
                            .get_version_num(),
                        4
                    );
                    let node_keys = |directory: &str| {
                        let node = ready
                            .tree
                            .root
                            .iter()
                            .find(|node| node.path == directory)
                            .unwrap();
                        assert_eq!(node.additions.unwrap().0, 4.0);
                        let wire = serde_json::to_vec(node).unwrap();
                        garcon_js::json::from_slice::<Value>(&wire)
                            .unwrap()
                            .as_object()
                            .unwrap()
                            .keys()
                            .skip(10)
                            .cloned()
                            .collect::<Vec<_>>()
                    };
                    assert_eq!(
                        node_keys("staged-first"),
                        ["stagedFacet", "changeKind", "unstagedFacet"]
                    );
                    assert_eq!(
                        node_keys("unstaged-first"),
                        ["unstagedFacet", "changeKind", "stagedFacet"]
                    );
                    ready.snapshot_id = "<document>".into();
                    ready.review_summary.document_id = "<document>".into();
                }
                outputs.push(snapshot);
            }
            assert!(
                trace
                    .borrow()
                    .iter()
                    .any(|command| command.args.iter().any(|arg| arg == "--numstat"))
            );
            let original = reference(&json!({ "snapshots": requests })).await;
            assert_eq!(serde_json::to_string(&outputs).unwrap(), original);
            let forwarded: Vec<GitWorkbenchSnapshotResponse> =
                serde_json::from_value(garcon_js::json::from_str(&original).unwrap()).unwrap();
            assert_eq!(
                serde_json::to_string(&forwarded).unwrap(),
                original,
                "deserializing kept the order"
            );
        })
        .await;
}

async fn staging_repo() -> GitFixture {
    let repo = GitFixture::with_commit().await;
    tokio::fs::write(repo.path().join("a.txt"), "changed\n")
        .await
        .unwrap();
    tokio::fs::write(repo.path().join("new.txt"), "one\ntwo\nthree\n")
        .await
        .unwrap();
    repo
}

async fn visible_proof(
    engine: &DiffEngine,
    documents: &GitReviewDocumentOperations,
    project: &str,
    file: &str,
    mode: GitReviewMode,
    context: &GitReviewDiffBatchContext<'_>,
) -> GitSelectionProof {
    let snapshot = engine
        .get_workbench_snapshot(
            &GitWorkbenchSnapshotOptions {
                project_path: project.into(),
                mode,
                context: 3,
                selected_file: OptionalNullable::some(file.into()),
                body_candidate_count: None,
            },
            context,
        )
        .await
        .unwrap();
    let GitWorkbenchSnapshotResponse::Ready(ready) = snapshot else {
        panic!("expected ready snapshot");
    };
    let response = documents
        .get_review_document_file_bodies(
            &GitReviewDocumentFileBodiesOptions {
                project_path: project.into(),
                document_id: ready.snapshot_id.clone(),
                files: vec![file.into()],
                purpose: GitReviewBodyPurpose::Visible,
            },
            context,
        )
        .await
        .unwrap();
    let GitReviewDocumentFileBodiesResponse::Ready { files, .. } = response else {
        panic!("expected ready body");
    };
    let body = &files[file];
    let summary = ready
        .review_summary
        .files
        .iter()
        .find(|summary| summary.path == file)
        .unwrap();
    assert_eq!(body.body_fingerprint, summary.body_fingerprint);
    GitSelectionProof {
        document: GitReviewDocumentRef {
            executor_id: "local".into(),
            instance_id: "test-instance".into(),
            document_id: ready.snapshot_id,
        },
        body_fingerprint: body.body_fingerprint.clone(),
        patch_digest: body.patch_digest.clone().unwrap(),
    }
}

#[tokio::test]
async fn stages_selected_untracked_lines_and_stages_and_unstages_a_hunk_like_bun() {
    LocalSet::new().run_until(async {
        let repo = staging_repo().await;
        let original = staging_repo().await;
        let project = repo.path().to_str().unwrap();
        let reference_path = original.path().to_str().unwrap();
        let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
        let engine = DiffEngine::new(registry.clone());
        let documents = GitReviewDocumentOperations::new(registry);
        let environment = TemporaryGitIndexEnvironment::default();
        let context = GitReviewDiffBatchContext {
            trace: None, signal: None, metrics: None, temporary_index: &environment,
        };
        let select = ExecutionStageSelectionOptions {
            selection: StageSelectionOptions {
                project_path: project.into(), file: "new.txt".into(), mode: GitStageMode::Stage,
                context_lines: Some(3), selection: GitLineSelection { line_indices: vec![1] },
            },
            proof: visible_proof(&engine, &documents, project, "new.txt", GitReviewMode::Working, &context).await,
        };
        let first = engine.stage_selection(&select, &context).await.unwrap();
        assert_eq!(repo.run(&["show", ":new.txt"]).await, "two\n");
        assert_eq!(tokio::fs::read(repo.path().join("new.txt")).await.unwrap(), b"one\ntwo\nthree\n");
        let old = engine.stage_selection(&select, &context).await.unwrap_err();
        assert_eq!(old.downcast_ref::<GitDomainError>().unwrap().code, "STALE_DOCUMENT");
        let mut results = vec![first];
        for (mode, body_mode) in [(GitStageMode::Stage, GitReviewMode::Working), (GitStageMode::Unstage, GitReviewMode::Staged)] {
            let request = ExecutionStageHunkOptions {
                hunk: StageHunkOptions {
                    project_path: project.into(), file: "a.txt".into(), mode,
                    context_lines: Some(3), hunk_index: 0,
                },
                proof: visible_proof(&engine, &documents, project, "a.txt", body_mode, &context).await,
            };
            results.push(engine.stage_hunk(&request, &context).await.unwrap());
            let index = if mode == GitStageMode::Stage { "changed\n" } else { "one\n" };
            assert_eq!(repo.run(&["show", ":a.txt"]).await, index);
        }
        let reference_results = reference(&json!({ "stage": [
            { "projectPath": reference_path, "file": "new.txt", "mode": "stage", "contextLines": 3, "selection": { "lineIndices": [1] } },
            { "projectPath": reference_path, "file": "a.txt", "mode": "stage", "contextLines": 3, "hunkIndex": 0 },
            { "projectPath": reference_path, "file": "a.txt", "mode": "unstage", "contextLines": 3, "hunkIndex": 0 },
        ] })).await;
        assert_eq!(serde_json::to_string(&results).unwrap(), reference_results);
        for args in [
            &["diff", "--cached", "--no-ext-diff"][..],
            &["diff", "--no-ext-diff"][..],
            &["status", "--porcelain=v1", "-z"][..],
        ] {
            assert_eq!(repo.run(args).await, original.run(args).await);
        }
    }).await;
}
