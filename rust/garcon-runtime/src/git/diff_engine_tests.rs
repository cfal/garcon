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

use super::diff_engine::{DiffEngine, not_repository_snapshot, selected_patch};
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
    visible_review(engine, documents, project, file, (mode, 3), context)
        .await
        .0
}

async fn visible_review(
    engine: &DiffEngine,
    documents: &GitReviewDocumentOperations,
    project: &str,
    file: &str,
    (mode, context_lines): (GitReviewMode, u8),
    context: &GitReviewDiffBatchContext<'_>,
) -> (GitSelectionProof, String) {
    let snapshot = engine
        .get_workbench_snapshot(
            &GitWorkbenchSnapshotOptions {
                project_path: project.into(),
                mode,
                context: context_lines,
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
    (
        GitSelectionProof {
            document: GitReviewDocumentRef {
                executor_id: "local".into(),
                instance_id: "test-instance".into(),
                document_id: ready.snapshot_id,
            },
            body_fingerprint: body.body_fingerprint.clone(),
            patch_digest: body.patch_digest.clone().unwrap(),
        },
        body.patch.clone().unwrap(),
    )
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

struct LiveReview {
    engine: DiffEngine,
    documents: GitReviewDocumentOperations,
    index_environment: TemporaryGitIndexEnvironment,
}

impl LiveReview {
    fn new() -> Self {
        let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
        Self {
            engine: DiffEngine::new(registry.clone()),
            documents: GitReviewDocumentOperations::new(registry),
            index_environment: TemporaryGitIndexEnvironment::default(),
        }
    }

    fn context(&self) -> GitReviewDiffBatchContext<'_> {
        GitReviewDiffBatchContext {
            trace: None,
            signal: None,
            metrics: None,
            temporary_index: &self.index_environment,
        }
    }

    async fn proof(
        &self,
        project: &str,
        file: &str,
        mode: GitReviewMode,
        context: u8,
    ) -> (GitSelectionProof, String) {
        visible_review(
            &self.engine,
            &self.documents,
            project,
            file,
            (mode, context),
            &self.context(),
        )
        .await
    }
}

fn select(
    project: &str,
    file: &str,
    mode: GitStageMode,
    context: u8,
    lines: Vec<u32>,
    proof: GitSelectionProof,
) -> ExecutionStageSelectionOptions {
    ExecutionStageSelectionOptions {
        selection: StageSelectionOptions {
            project_path: project.into(),
            file: file.into(),
            mode,
            context_lines: Some(context),
            selection: GitLineSelection {
                line_indices: lines,
            },
        },
        proof,
    }
}

fn patch_indices(patch: &str, targets: &[&str]) -> Vec<u32> {
    let mut in_hunk = false;
    let mut index = 0;
    let mut picked = Vec::new();
    for line in patch.split_terminator('\n') {
        if line.starts_with("diff --git ") {
            in_hunk = false;
        }
        if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && !line.starts_with('\\') {
            if targets.contains(&line) {
                picked.push(index);
            }
            index += 1;
        }
    }
    assert_eq!(picked.len(), targets.len(), "{patch}");
    picked
}

async fn multi_hunk_fixture() -> GitFixture {
    let repo = GitFixture::with_commit().await;
    let body = |changed| {
        (0..30)
            .map(|i| {
                let extra = match (changed, i) {
                    (true, 1) => "FIRST\n",
                    (true, 10) => "SKIP\n",
                    (true, 20) => "LAST\n",
                    _ => "",
                };
                format!("line {i}\n{extra}")
            })
            .collect::<String>()
    };
    tokio::fs::write(repo.path().join("a.txt"), body(false))
        .await
        .unwrap();
    repo.run(&["commit", "-am", "record hunk context"]).await;
    tokio::fs::write(repo.path().join("a.txt"), body(true))
        .await
        .unwrap();
    repo
}

#[tokio::test]
async fn stage_selection_offsets_only_retained_hunks_and_reverses_a_partial_selection() {
    LocalSet::new().run_until(async {
        let repo = multi_hunk_fixture().await;
        let original = multi_hunk_fixture().await;
        let project = repo.path().to_str().unwrap();
        let reference_path = original.path().to_str().unwrap();
        let review = LiveReview::new();
        let (proof, patch) = review.proof(project, "a.txt", GitReviewMode::Working, 1).await;
        let lines = patch_indices(&patch, &["+FIRST", "+LAST"]);
        assert_eq!(patch.lines().filter(|line| line.starts_with("@@")).count(), 3);
        let transformed = selected_patch("a.txt", GitStageMode::Stage, &patch, &lines).unwrap();
        let headers: Vec<_> = transformed.lines().filter(|line| line.starts_with("@@")).collect();
        assert_eq!(headers.len(), 2);
        assert!(headers[0].starts_with("@@ -2,2 +2,3 @@"), "{}", headers[0]);
        assert!(headers[1].starts_with("@@ -21,2 +22,3 @@"), "{}", headers[1]);
        let stage = select(project, "a.txt", GitStageMode::Stage, 1, lines.clone(), proof);
        let first = review.engine.stage_selection(&stage, &review.context()).await.unwrap();
        let index = repo.run(&["show", ":a.txt"]).await;
        assert!(index.contains("line 1\nFIRST\nline 2\n"));
        assert!(index.contains("line 20\nLAST\nline 21\n"));
        assert!(!index.contains("SKIP"));

        let (proof, staged) = review.proof(project, "a.txt", GitReviewMode::Staged, 1).await;
        let reverse = patch_indices(&staged, &["+FIRST"]);
        let unstage = select(project, "a.txt", GitStageMode::Unstage, 1, reverse.clone(), proof);
        let second = review.engine.stage_selection(&unstage, &review.context()).await.unwrap();
        let index = repo.run(&["show", ":a.txt"]).await;
        assert!(!index.contains("FIRST"));
        assert!(index.contains("line 20\nLAST\nline 21\n"));
        assert_eq!(
            serde_json::to_string(&[first, second]).unwrap(),
            reference(&json!({ "stage": [
                { "projectPath": reference_path, "file": "a.txt", "mode": "stage", "contextLines": 1, "selection": { "lineIndices": lines } },
                { "projectPath": reference_path, "file": "a.txt", "mode": "unstage", "contextLines": 1, "selection": { "lineIndices": reverse } },
            ] })).await,
        );
        assert_eq!(repo.run(&["diff", "--cached"]).await, original.run(&["diff", "--cached"]).await);
        assert_eq!(repo.run(&["diff"]).await, original.run(&["diff"]).await);
    }).await;
}

#[tokio::test]
async fn partial_selections_keep_or_drop_the_no_newline_marker_with_its_line() {
    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        let original = GitFixture::with_commit().await;
        let project = repo.path().to_str().unwrap();
        let reference_path = original.path().to_str().unwrap();
        let review = LiveReview::new();
        let mut results = Vec::new();
        let mut steps = Vec::new();
        for (file, line, expected) in [
            ("keep.txt", 1, "no newline"),
            ("drop.txt", 0, "retained\n"),
        ] {
            for repo in [&repo, &original] {
                tokio::fs::write(repo.path().join(file), "retained\nno newline").await.unwrap();
            }
            let (proof, patch) = review.proof(project, file, GitReviewMode::Working, 2).await;
            assert!(patch.contains("\\ No newline at end of file"));
            let request = select(project, file, GitStageMode::Stage, 2, vec![line], proof);
            results.push(review.engine.stage_selection(&request, &review.context()).await.unwrap());
            assert_eq!(repo.run(&["show", &format!(":{file}")]).await, expected);
            steps.push(json!({ "projectPath": reference_path, "file": file, "mode": "stage", "contextLines": 2, "selection": { "lineIndices": [line] } }));
        }
        assert_eq!(serde_json::to_string(&results).unwrap(), reference(&json!({ "stage": steps })).await);
        assert_eq!(repo.run(&["diff", "--cached"]).await, original.run(&["diff", "--cached"]).await);
    }).await;
}

#[cfg(unix)]
#[tokio::test]
async fn stage_hunk_and_selection_exclude_subsequent_type_change_section_headers() {
    LocalSet::new().run_until(async {
        for use_hunk in [true, false] {
            let repo = GitFixture::with_commit().await;
            let original = GitFixture::with_commit().await;
            for repo in [&repo, &original] {
                tokio::fs::write(repo.path().join("a.txt"), "first\nsecond\nthird\n").await.unwrap();
                repo.run(&["commit", "-am", "Record regular file"]).await;
                tokio::fs::remove_file(repo.path().join("a.txt")).await.unwrap();
                std::os::unix::fs::symlink("target.txt", repo.path().join("a.txt")).unwrap();
            }
            let project = repo.path().to_str().unwrap();
            let review = LiveReview::new();
            let (proof, patch) = review.proof(project, "a.txt", GitReviewMode::Working, 2).await;
            assert_eq!(patch.lines().filter(|line| line.starts_with("diff --git ")).count(), 2);
            let mut step = json!({
                "projectPath": original.path().to_str().unwrap(), "file": "a.txt", "mode": "stage", "contextLines": 2,
            });
            let result = if use_hunk {
                step["hunkIndex"] = json!(0);
                review.engine.stage_hunk(&ExecutionStageHunkOptions {
                    hunk: StageHunkOptions {
                        project_path: project.into(), file: "a.txt".into(), mode: GitStageMode::Stage,
                        context_lines: Some(2), hunk_index: 0,
                    }, proof,
                }, &review.context()).await.unwrap()
            } else {
                step["selection"] = json!({ "lineIndices": [0] });
                let request = select(project, "a.txt", GitStageMode::Stage, 2, vec![0], proof);
                review.engine.stage_selection(&request, &review.context()).await.unwrap()
            };
            assert_eq!(repo.run(&["show", ":a.txt"]).await, if use_hunk { "" } else { "second\nthird\n" });
            assert!(repo.run(&["ls-files", "-s", "--", "a.txt"]).await.starts_with("100644 "));
            assert_eq!(tokio::fs::read_link(repo.path().join("a.txt")).await.unwrap().to_str(), Some("target.txt"));
            assert_eq!(serde_json::to_string(&[result]).unwrap(), reference(&json!({ "stage": [step] })).await);
            assert_eq!(repo.run(&["diff", "--cached"]).await, original.run(&["diff", "--cached"]).await);
        }
    }).await;
}

#[tokio::test]
async fn invalid_selections_and_identifiers_leave_the_index_unchanged() {
    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        let project = repo.path().to_str().unwrap();
        tokio::fs::write(repo.path().join("a.txt"), "one\ntwo\nthree\n").await.unwrap();
        repo.run(&["commit", "-am", "before selection"]).await;
        tokio::fs::write(repo.path().join("a.txt"), "one\nchanged\nthree\n").await.unwrap();
        let index = repo.path().join(".git/index");
        let initial = tokio::fs::read(&index).await.unwrap();
        let review = LiveReview::new();
        let (proof, patch) = review.proof(project, "a.txt", GitReviewMode::Working, 3).await;
        assert_eq!(patch_indices(&patch, &[" one"]), [0]);
        let request = || json!({
            "projectPath": project, "file": "a.txt", "mode": "stage", "contextLines": 3, "expectError": true,
            "selection": { "lineIndices": [2] },
        });
        let mut errors = Vec::new();
        let mut steps = Vec::new();
        for lines in [vec![], vec![0]] {
            let mut step = request();
            step["selection"] = json!({ "lineIndices": lines });
            let invalid = select(project, "a.txt", GitStageMode::Stage, 3, lines, proof.clone());
            let error = review.engine.stage_selection(&invalid, &review.context()).await.unwrap_err();
            let error = error.downcast_ref::<GitDomainError>().unwrap();
            assert_eq!(error.code, "INVALID_INPUT");
            assert_eq!(error.message, "No changed lines were selected.");
            errors.push(json!({ "code": error.code, "message": error.message }));
            steps.push(step);
        }
        let invalid_hunk = ExecutionStageHunkOptions {
            hunk: StageHunkOptions {
                project_path: project.into(), file: "a.txt".into(), mode: GitStageMode::Stage,
                context_lines: Some(3), hunk_index: 50,
            }, proof: proof.clone(),
        };
        let error = review.engine.stage_hunk(&invalid_hunk, &review.context()).await.unwrap_err();
        let error = error.downcast_ref::<GitDomainError>().unwrap();
        assert_eq!(error.code, "INVALID_INPUT");
        assert_eq!(error.message, "Invalid hunk index 50");
        errors.push(json!({ "code": error.code, "message": error.message }));
        let mut step = request();
        step.as_object_mut().unwrap().shift_remove("selection");
        step["hunkIndex"] = json!(50);
        steps.push(step);

        for mismatch in ["mode", "context", "digest", "fingerprint"] {
            let mut step = request();
            let mut invalid = select(project, "a.txt", GitStageMode::Stage, 3, vec![2], proof.clone());
            match mismatch {
                "mode" => {
                    invalid.selection.mode = GitStageMode::Unstage;
                    step["mode"] = json!("unstage");
                    step["reviewMode"] = json!("working");
                }
                "context" => {
                    invalid.selection.context_lines = Some(2);
                    step["contextLines"] = json!(2);
                    step["reviewContext"] = json!(3);
                }
                "digest" => {
                    invalid.proof.patch_digest = "0".repeat(64);
                    step["patchDigest"] = json!(invalid.proof.patch_digest);
                }
                _ => {
                    invalid.proof.body_fingerprint = "stale".into();
                    step["bodyFingerprint"] = json!("stale");
                }
            }
            let error = review.engine.stage_selection(&invalid, &review.context()).await.unwrap_err();
            let error = error.downcast_ref::<GitDomainError>().unwrap();
            assert_eq!(error.code, "STALE_DOCUMENT", "{mismatch}");
            errors.push(json!({ "code": error.code, "message": error.message }));
            steps.push(step);
        }
        assert_eq!(serde_json::to_string(&errors).unwrap(), reference(&json!({ "stage": steps })).await);
        assert_eq!(tokio::fs::read(index).await.unwrap(), initial);
    }).await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_git_apply_leaves_the_index_bytes_unchanged() {
    LocalSet::new()
        .run_until(async {
            use super::types::GitProcessError;

            let repo = GitFixture::with_commit().await;
            let project = repo.path().to_str().unwrap();
            let file = "tab\tname.txt";
            tokio::fs::write(repo.path().join(file), "one\n")
                .await
                .unwrap();
            repo.run(&["add", "--", file]).await;
            repo.run(&["commit", "-m", "track a tab path"]).await;
            tokio::fs::write(repo.path().join(file), "one\ntwo\n")
                .await
                .unwrap();
            let review = LiveReview::new();
            let (proof, patch) = review.proof(project, file, GitReviewMode::Working, 3).await;
            let index_path = repo.path().join(".git/index");
            let before = tokio::fs::read(&index_path).await.unwrap();
            let lines = patch_indices(&patch, &["+two"]);
            let request = select(project, file, GitStageMode::Stage, 3, lines.clone(), proof);
            let failure = review
                .engine
                .stage_selection(&request, &review.context())
                .await
                .unwrap_err();
            let failure = failure.downcast_ref::<GitProcessError>().unwrap();
            assert_eq!(failure.code, Some(1));
            assert_eq!(tokio::fs::read(&index_path).await.unwrap(), before);
            let expected = reference(&json!({ "stage": [{
            "projectPath": project, "file": file, "mode": "stage", "contextLines": 3,
            "selection": { "lineIndices": lines }, "expectError": true,
        }] }))
            .await;
            assert_eq!(
                serde_json::to_string(&[
                    json!({ "code": failure.code, "message": failure.message })
                ])
                .unwrap(),
                expected
            );
            assert_eq!(tokio::fs::read(&index_path).await.unwrap(), before);
        })
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn workbench_reads_head_only_for_working_deletions_and_preserves_tab_conflict_and_binary_summary()
 {
    LocalSet::new().run_until(async {
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;

        use garcon_contract::git::{GitReviewBodyState, GitReviewLimitReason};
        use crate::ChildEnvironment;
        use super::operation_context::with_git_operation_with_environment;

        let repo = GitFixture::with_commit().await;
        let project = repo.path().to_str().unwrap();
        let tab_file = "tab\tname.txt";
        for file in ["deleted.txt", "conflict.txt", tab_file] {
            tokio::fs::write(repo.path().join(file), "one\n").await.unwrap();
        }
        tokio::fs::write(repo.path().join("deleted.txt"), "deleted\n").await.unwrap();
        repo.run(&["add", "--", "deleted.txt", "conflict.txt", tab_file]).await;
        repo.run(&["commit", "-m", "tracked review sources"]).await;
        tokio::fs::write(repo.path().join(tab_file), "one\ntwo\n").await.unwrap();
        tokio::fs::write(repo.path().join("a.txt"), "one\nstaged text\n").await.unwrap();
        repo.run(&["add", "--", "a.txt"]).await;
        tokio::fs::write(repo.path().join("a.txt"), b"\x00worktree\n").await.unwrap();

        let tools = tempfile::tempdir().unwrap();
        let script = tools.path().join("git");
        let log = tools.path().join("commands.log");
        let path = std::env::var_os("PATH").unwrap();
        let real_git = std::env::split_paths(&path).map(|dir| dir.join("git"))
            .find(|candidate| candidate.is_file()).unwrap();
        tokio::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$REVIEW_TEST_LOG\"\nexec \"$REVIEW_TEST_GIT\" \"$@\"\n",
        ).await.unwrap();
        tokio::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).await.unwrap();
        let env: ChildEnvironment = std::env::vars_os().filter(|(key, _)| key != "PATH").chain([
            (OsString::from("PATH"), tools.path().as_os_str().into()), ("REVIEW_TEST_LOG".into(), log.as_os_str().into()),
            ("REVIEW_TEST_GIT".into(), real_git.into_os_string()),
        ]).collect::<Vec<_>>().into();
        let review = LiveReview::new();
        for (phase, mode) in [
            (0, GitReviewMode::Working), (1, GitReviewMode::Staged),
            (2, GitReviewMode::Working), (3, GitReviewMode::Staged), (4, GitReviewMode::Working),
        ] {
            if phase == 2 {
                tokio::fs::remove_file(repo.path().join("deleted.txt")).await.unwrap();
            } else if phase == 3 {
                repo.run(&["add", "-u", "--", "deleted.txt"]).await;
            } else if phase == 4 {
                let mut conflicts = format!("0 {}\tconflict.txt\n", "0".repeat(40));
                for (stage, content) in [(1, "one\n"), (2, "ours\n"), (3, "theirs\n")] {
                    let oid = repo.git(&["hash-object", "-w", "--stdin"], Some(content.as_bytes())).await;
                    conflicts.push_str(&format!("100644 {} {stage}\tconflict.txt\n", oid.trim()));
                }
                repo.git(&["update-index", "--index-info"], Some(conflicts.as_bytes())).await;
            }
            let request = GitWorkbenchSnapshotOptions {
                project_path: project.into(), mode, context: 3, selected_file: OptionalNullable::ABSENT,
                body_candidate_count: None,
            };
            let response = with_git_operation_with_environment(project, None, false, Some(env.clone()), |signal| {
                let review = &review;
                let request = &request;
                async move {
                    review.engine.get_workbench_snapshot(request, &GitReviewDiffBatchContext {
                        signal: Some(&signal), ..review.context()
                    }).await
                }
            }).await.unwrap();
            let GitWorkbenchSnapshotResponse::Ready(mut ready) = response else { panic!("expected ready review"); };
            let files = &ready.review_summary.files;
            if phase == 2 {
                assert!(files.iter().any(|file| file.path == "deleted.txt" && file.work_tree_status == "D"));
            }
            if mode == GitReviewMode::Working {
                let tabs = files.iter().find(|entry| entry.path == tab_file).unwrap();
                assert_eq!((tabs.additions.0, tabs.deletions.0), (1.0, 0.0));
                if phase == 4 {
                    let conflicted = files.iter().find(|entry| entry.path == "conflict.txt").unwrap();
                    assert_eq!(conflicted.body_state, GitReviewBodyState::TooLarge);
                    assert_eq!(conflicted.limit_reason, Some(GitReviewLimitReason::UnsupportedFileKind));
                }
            } else {
                let staged = files.iter().find(|entry| entry.path == "a.txt").unwrap();
                assert_eq!(staged.body_state, GitReviewBodyState::Unloaded);
                let (_, patch) = review.proof(project, "a.txt", GitReviewMode::Staged, 3).await;
                assert!(patch.contains("+staged text\n"));
            }
            assert_eq!(ready.snapshot_id, ready.review_summary.document_id);
            assert_eq!(uuid::Uuid::parse_str(&ready.snapshot_id).unwrap().get_version_num(), 4);
            ready.snapshot_id = "<document>".into();
            ready.review_summary.document_id = "<document>".into();
            let snapshot = GitWorkbenchSnapshotResponse::Ready(ready);
            assert_eq!(
                serde_json::to_string(&[snapshot]).unwrap(),
                reference(&json!({ "snapshots": [request] })).await,
            );
            let commands = tokio::fs::read_to_string(&log).await.expect("the scoped Git executable logged commands");
            let trees: Vec<_> = commands.lines().filter(|line| line.starts_with("ls-tree ")).collect();
            assert_eq!(trees, if phase < 2 { vec![] } else { vec!["ls-tree -rz HEAD -- deleted.txt"] });
        }
    }).await;
}
