use std::cell::RefCell;
use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;

use garcon_cases::{CaseError, replay, round_tripped};
use garcon_contract::git::{
    GitCommitFileStatus, GitFileReviewCategory, GitReviewBodyPurpose, GitReviewBodyState,
    GitReviewDocumentFileBodiesOptions, GitReviewDocumentFileBodiesResponse as Response,
    GitReviewFilePatchBody, GitReviewLimitReason, GitReviewMode,
};
use garcon_js::Number;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::task::LocalSet;

use super::git_fixture::GitFixture;
use super::review_diff_batch::{
    GitReviewDiffBatchContext, is_git_review_collection_limit_body,
    limit_git_review_response_bodies, load_review_diff_batches, loaded_git_review_body_totals,
    plan_review_diff_batches,
};
use super::review_document_registry::{
    GitReviewDocumentRegistry, GitReviewDocumentSource, RegisterGitReviewDocumentInput,
    RegisteredGitReviewChange, RegisteredGitReviewDocument, RegisteredGitReviewFile,
};
use super::review_document_service::GitReviewDocumentOperations;
use super::temporary_index::TemporaryGitIndexEnvironment;
use super::working_path_token::{
    WorkingPathScope, WorkingPathTokenInputs, capture_working_path_tokens,
};

#[test]
fn recorded_review_diff_batch_matches() {
    const CASES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/cases/git/review-diff-batch"
    );
    replay(PathBuf::from(CASES), |function, args| {
        let input = round_tripped(function, args.first())?
            .ok_or_else(|| CaseError::unhandled(function))?
            .into_owned();
        fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CaseError> {
            serde_json::from_value(value)
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        }
        fn encode(value: impl Serialize) -> Result<Value, CaseError> {
            let result = serde_json::to_vec(&value)
                .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            garcon_js::json::from_slice(&result)
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        }
        match function {
            "planReviewDiffBatches" => {
                let files: Vec<RegisteredGitReviewFile> = decode(input)?;
                encode(plan_review_diff_batches(&files))
            }
            "loadedGitReviewBodyTotals" => {
                let bodies: Vec<GitReviewFilePatchBody> = decode(input)?;
                encode(loaded_git_review_body_totals(&bodies))
            }
            "limitGitReviewResponseBodies" => {
                let bodies: Vec<GitReviewFilePatchBody> = decode(input)?;
                encode(limit_git_review_response_bodies(bodies))
            }
            "isGitReviewCollectionLimitBody" => {
                encode(is_git_review_collection_limit_body(&decode(input)?))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

fn review_file(
    path: &str,
    status: GitCommitFileStatus,
    raw_status: &str,
    rows: f64,
) -> RegisteredGitReviewFile {
    RegisteredGitReviewFile {
        path: path.into(),
        original_path: None,
        change: RegisteredGitReviewChange::TreeDiff {
            status,
            raw_status: raw_status.into(),
        },
        category: GitFileReviewCategory::Normal,
        additions: Number(1.0),
        deletions: Number(1.0),
        estimated_rows: Number(rows),
        body_state: GitReviewBodyState::Unloaded,
        body_fingerprint: format!("fingerprint:{path}"),
        is_binary: false,
        is_too_large: false,
        limit_reason: None,
        limit_message: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Registration<'a> {
    project_path: &'a str,
    source_cache_key: &'a str,
    repo_root: &'a str,
    context: usize,
    source: GitReviewDocumentSource,
    files: Vec<RegisteredGitReviewFile>,
}

impl Registration<'_> {
    fn register(
        &self,
        registry: &GitReviewDocumentRegistry,
    ) -> std::rc::Rc<RegisteredGitReviewDocument> {
        registry
            .register(RegisterGitReviewDocumentInput {
                project_path: self.project_path.into(),
                repo_root: self.repo_root.into(),
                source_cache_key: self.source_cache_key.into(),
                context: self.context,
                source: self.source.clone(),
                files: self.files.clone(),
                working_path_tokens: Default::default(),
            })
            .unwrap()
    }
}

async fn bun_review_bodies(registration: &Registration<'_>, requests: &[Value]) -> String {
    let mut child = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/git-review-bodies.ts"
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
        .write_all(
            &serde_json::to_vec(&json!({ "registration": registration, "requests": requests }))
                .unwrap(),
        )
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
async fn loads_multiple_revision_files_through_one_compact_body_batch_and_caches_them() {
    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        tokio::fs::write(repo.path().join("2"), "old displayed\n").await.unwrap();
        tokio::fs::write(repo.path().join("space name.txt"), "rename me\n").await.unwrap();
        repo.run(&["add", "2", "space name.txt"]).await;
        repo.run(&["commit", "-m", "add paths"]).await;
        let before = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        tokio::fs::write(repo.path().join("a.txt"), "new a\n").await.unwrap();
        tokio::fs::write(repo.path().join("2"), "new displayed\n").await.unwrap();
        repo.run(&["mv", "space name.txt", "renamed.txt"]).await;
        repo.run(&["add", "--", "a.txt", "2"]).await;
        repo.run(&["commit", "-m", "change"]).await;
        let target = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        let path = repo.path().to_str().unwrap();
        let mut rename = review_file("renamed.txt", GitCommitFileStatus::Renamed, "R100", 3.0);
        rename.original_path = Some("space name.txt".into());
        let registration = Registration {
            project_path: path, repo_root: path, source_cache_key: "review:oracle", context: 3,
            source: GitReviewDocumentSource::ComparisonRevisions { effective_from_hash: before, to_hash: target },
            files: vec![
                review_file("a.txt", GitCommitFileStatus::Modified, "M", 3.0),
                review_file("2", GitCommitFileStatus::Modified, "M", 3.0),
                rename,
                review_file("missing.txt", GitCommitFileStatus::Added, "?", 3.0),
            ],
        };
        let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
        let document = registration.register(&registry);
        let operations = GitReviewDocumentOperations::new(registry);
        let temporary_index = TemporaryGitIndexEnvironment::default();
        let requests = [
            json!({ "purpose": "visible", "files": ["a.txt", "renamed.txt", "2", "missing.txt", "a.txt"] }),
            json!({ "purpose": "prefetch", "files": ["2", "renamed.txt", "a.txt"] }),
        ];
        let mut results = Vec::new();
        let mut diffs: Vec<Vec<_>> = Vec::new();
        for request in &requests {
            let trace = RefCell::new(Vec::new());
            let result = operations.get_review_document_file_bodies(
                &GitReviewDocumentFileBodiesOptions {
                    project_path: path.into(), document_id: document.id.clone(),
                    files: serde_json::from_value(request["files"].clone()).unwrap(),
                    purpose: serde_json::from_value(request["purpose"].clone()).unwrap(),
                },
                &GitReviewDiffBatchContext { trace: Some(&trace), signal: None, metrics: None, temporary_index: &temporary_index },
            ).await.unwrap();
            let Response::Ready { document_id, files, errors, deferred_files } = result else {
                panic!("expected ready review bodies: {result:?}");
            };
            assert_eq!(document_id, document.id);
            assert_eq!(files["a.txt"].body_state, GitReviewBodyState::Loaded);
            assert!(files["renamed.txt"].patch.as_ref().unwrap().contains("rename from space name.txt"));
            assert!(deferred_files.is_empty());
            results.push(Response::Ready { document_id: "<document>".into(), files, errors, deferred_files });
            diffs.push(trace.into_inner().into_iter().map(|trace| trace.args).collect());
        }
        assert_eq!(diffs[0].len(), 1);
        assert!(diffs[1].is_empty());
        #[derive(Serialize)]
        struct Compared {
            results: Vec<Response>,
            diffs: Vec<Vec<Vec<String>>>,
        }
        assert_eq!(
            serde_json::to_string(&Compared { results, diffs }).unwrap(),
            bun_review_bodies(&registration, &requests).await,
        );
    }).await;
}

#[tokio::test]
async fn stops_later_git_batches_after_the_response_reaches_the_aggregate_row_budget() {
    LocalSet::new().run_until(async {
        let repo = GitFixture::with_commit().await;
        let paths = ["a.txt", "b.txt", "c.txt", "d.txt"];
        for path in paths { tokio::fs::write(repo.path().join(path), "old\n").await.unwrap(); }
        repo.run(&["add", "--", "a.txt", "b.txt", "c.txt", "d.txt"]).await;
        repo.run(&["commit", "-m", "before"]).await;
        let base = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        let text = (0..34_000).map(|index| format!("new line {index}\n")).collect::<String>();
        for path in paths { tokio::fs::write(repo.path().join(path), &text).await.unwrap(); }
        repo.run(&["commit", "-am", "large change"]).await;
        let target = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
        let path = repo.path().to_str().unwrap();
        let registration = Registration {
            project_path: path, repo_root: path, source_cache_key: "review:budget", context: 3,
            source: GitReviewDocumentSource::ComparisonRevisions { effective_from_hash: base, to_hash: target },
            files: paths.iter().map(|path| review_file(path, GitCommitFileStatus::Modified, "M", 34_000.0)).collect(),
        };
        let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
        let document = registration.register(&registry);
        let trace = RefCell::new(Vec::new());
        let environment = TemporaryGitIndexEnvironment::default();
        let context = GitReviewDiffBatchContext { trace: Some(&trace), signal: None, metrics: None, temporary_index: &environment };
        let files: Vec<_> = document.files_by_path.values().collect();
        let result = load_review_diff_batches(&document, &files, &context, Default::default()).await.unwrap();
        assert_eq!(trace.borrow().len(), 3);
        assert_eq!(result.bodies.iter().map(|body| body.path.as_str()).collect::<Vec<_>>(), paths[..3]);
        assert_eq!(result.bodies[2].limit_reason, Some(GitReviewLimitReason::CollectionTooManyRows));
        assert_eq!(result.bodies[2].limit_message.as_deref(), Some("Stopped loading after 68,004 rendered rows."));
        let operations = GitReviewDocumentOperations::new(registry);
        let mut request = GitReviewDocumentFileBodiesOptions {
            project_path: path.into(), document_id: document.id.clone(),
            files: paths.map(str::to_owned).to_vec(), purpose: GitReviewBodyPurpose::Visible,
        };
        let response = operations.get_review_document_file_bodies(&request, &context).await.unwrap();
        assert!(matches!(response, Response::Ready { deferred_files, .. } if deferred_files == paths[2..]));
        request.files = vec![paths[2].into()];
        let retry = operations.get_review_document_file_bodies(&request, &context).await.unwrap();
        assert!(matches!(retry, Response::Ready { files, .. } if files[paths[2]].body_state == GitReviewBodyState::Loaded));
        assert_eq!(trace.borrow().len(), 7);
    }).await;
}

#[tokio::test]
async fn keeps_staged_bodies_valid_across_worktree_only_edits() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let path = repo.path().to_str().unwrap();
            let file_path = repo.path().join("a.txt");
            let base = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
            tokio::fs::write(&file_path, "staged\n").await.unwrap();
            repo.run(&["add", "--", "a.txt"]).await;
            let paths = vec!["a.txt".to_owned()];
            let tokens = capture_working_path_tokens(
                path,
                &paths,
                WorkingPathTokenInputs {
                    scope: WorkingPathScope::Index,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
            let registry = Rc::new(GitReviewDocumentRegistry::new(Default::default()));
            let mut file = review_file("a.txt", GitCommitFileStatus::Modified, "M", 3.0);
            file.change = RegisteredGitReviewChange::Workbench {
                index_status: "M".into(),
                work_tree_status: " ".into(),
            };
            let document = registry
                .register(RegisterGitReviewDocumentInput {
                    project_path: path.into(),
                    repo_root: path.into(),
                    source_cache_key: "review:staged".into(),
                    context: 3,
                    source: GitReviewDocumentSource::Workbench {
                        mode: GitReviewMode::Staged,
                        staged_base_hash: base,
                        fingerprint: "test".into(),
                    },
                    files: vec![file],
                    working_path_tokens: tokens,
                })
                .unwrap();
            tokio::fs::write(&file_path, "worktree\n").await.unwrap();
            let operations = GitReviewDocumentOperations::new(registry);
            let request = GitReviewDocumentFileBodiesOptions {
                project_path: path.into(),
                document_id: document.id.clone(),
                files: paths.clone(),
                purpose: GitReviewBodyPurpose::Visible,
            };
            let environment = TemporaryGitIndexEnvironment::default();
            let context = GitReviewDiffBatchContext {
                trace: None,
                signal: None,
                metrics: None,
                temporary_index: &environment,
            };
            let first = operations
                .get_review_document_file_bodies(&request, &context)
                .await
                .unwrap();
            assert!(matches!(first, Response::Ready { files, .. }
                if files["a.txt"].patch.as_ref().unwrap().contains("+staged\n")));
            repo.run(&["add", "--", "a.txt"]).await;
            let after = operations
                .get_review_document_file_bodies(&request, &context)
                .await
                .unwrap();
            assert!(
                matches!(after, Response::Stale { changed_paths, .. } if changed_paths == paths)
            );
        })
        .await;
}

#[tokio::test]
async fn isolates_a_failed_untracked_path_and_cleans_every_scratch_index() {
    LocalSet::new()
        .run_until(async {
            let repo = GitFixture::with_commit().await;
            let path = repo.path().to_str().unwrap();
            let base = repo.run(&["rev-parse", "HEAD"]).await.trim().to_owned();
            let paths = ["valid name.txt", "ignored.txt"];
            tokio::fs::write(repo.path().join(".gitignore"), "ignored.txt\n")
                .await
                .unwrap();
            for path in paths {
                tokio::fs::write(repo.path().join(path), "synthetic\n")
                    .await
                    .unwrap();
            }
            let index_path = repo.path().join(".git/index");
            let index_before = tokio::fs::read(&index_path).await.unwrap();
            let registration = Registration {
                project_path: path,
                repo_root: path,
                source_cache_key: "review:untracked",
                context: 3,
                source: GitReviewDocumentSource::Workbench {
                    mode: GitReviewMode::Working,
                    staged_base_hash: base,
                    fingerprint: "test".into(),
                },
                files: paths
                    .iter()
                    .map(|path| review_file(path, GitCommitFileStatus::Added, "?", 2.0))
                    .collect(),
            };
            let registry = GitReviewDocumentRegistry::new(Default::default());
            let document = registration.register(&registry);
            let files: Vec<_> = document.files_by_path.values().collect();
            let environment = TemporaryGitIndexEnvironment::default();
            let context = GitReviewDiffBatchContext {
                trace: None,
                signal: None,
                metrics: None,
                temporary_index: &environment,
            };
            let result = load_review_diff_batches(&document, &files, &context, Default::default())
                .await
                .unwrap();
            assert_eq!(result.metrics.batch_count, 3);
            assert_eq!(result.metrics.bisection_count, 1);
            assert_eq!(result.bodies[0].path, paths[0]);
            assert!(
                result.bodies[0]
                    .patch
                    .as_ref()
                    .unwrap()
                    .contains("+synthetic\n")
            );
            assert_eq!(result.bodies[1].path, paths[1]);
            assert_eq!(result.bodies[1].body_state, GitReviewBodyState::Error);
            assert!(result.errors[paths[1]].contains("ignored.txt"));
            assert_eq!(tokio::fs::read(&index_path).await.unwrap(), index_before);
            let mut directory = tokio::fs::read_dir(repo.path().join(".git")).await.unwrap();
            while let Some(entry) = directory.next_entry().await.unwrap() {
                assert!(
                    !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".garcon-index-")
                );
            }
        })
        .await;
}
