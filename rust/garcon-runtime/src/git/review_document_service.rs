//! Ports `server/runtime/git/review-document-service.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use garcon_contract::git::{
    GitReviewBodyPurpose, GitReviewBodyState, GitReviewDocumentFileBodiesOptions,
    GitReviewDocumentFileBodiesResponse as Response, GitReviewFilePatchBody,
};
use garcon_contract::git_diagnostics::{GitReviewRouteMetrics, GitReviewRoutePhaseName as Phase};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_contract::git_execution::GIT_MAX_RESULT_BYTES;
use garcon_interface::resources::ExecutorResult;
use garcon_js::Number;
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::cancellation::{abort_error, check_cancelled};

use super::git_domain_error::GitDomainError;
use super::review_diff_batch::{
    GitReviewDiffBatchContext, compare_object_keys, is_git_review_collection_limit_body,
    limit_git_review_response_bodies, load_review_diff_batches, loaded_git_review_body_totals,
};
use super::review_document_registry::{
    GitReviewDocumentRegistry, GitReviewDocumentSource as Source, RegisteredGitReviewFile,
};
use super::review_performance::{measure_git_review_phase, measure_git_review_phase_sync};
use super::working_path_token::{
    GitWorkingPathToken, WorkingPathScope, WorkingPathTokenInputs, capture_working_path_tokens,
    changed_working_path_tokens,
};

const MAX_ENCODED_RESPONSE_BYTES: usize = GIT_MAX_RESULT_BYTES - 512 * 1024;

fn encoded_member_bytes(path: &str, value: &impl Serialize) -> serde_json::Result<usize> {
    // The encoded key and value exclude braces and reserve a colon and a comma.
    Ok(serde_json::to_vec(path)?.len() + serde_json::to_vec(value)?.len() + 2)
}

fn expected_tokens(
    all_tokens: &IndexMap<String, GitWorkingPathToken>,
    paths: &[String],
) -> Result<IndexMap<String, GitWorkingPathToken>, GitDomainError> {
    paths
        .iter()
        .map(|path| {
            let token = all_tokens.get(path).ok_or_else(|| {
                GitDomainError::new(
                    "STALE_DOCUMENT",
                    format!("The review no longer has working-tree identity for {path}."),
                )
            })?;
            Ok((path.clone(), token.clone()))
        })
        .collect()
}

pub struct GitReviewDocumentOperations {
    registry: Rc<GitReviewDocumentRegistry>,
    prefetch: Mutex<()>,
}

impl GitReviewDocumentOperations {
    pub fn new(registry: Rc<GitReviewDocumentRegistry>) -> Self {
        Self {
            registry,
            prefetch: Mutex::new(()),
        }
    }

    pub async fn get_review_document_file_bodies(
        &self,
        options: &GitReviewDocumentFileBodiesOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<Response> {
        // The FIFO lock only serializes prefetches. The future stays in the caller's Git operation scope.
        let _prefetch = if options.purpose == GitReviewBodyPurpose::Prefetch {
            let guard = if let Some(signal) = context.signal {
                tokio::select! {
                    biased;
                    () = signal.cancelled() => return Err(abort_error("The operation was aborted.").into()),
                    guard = self.prefetch.lock() => guard,
                }
            } else {
                self.prefetch.lock().await
            };
            check_cancelled(context.signal)?;
            Some(guard)
        } else {
            None
        };
        self.read(options, context).await
    }

    async fn read(
        &self,
        options: &GitReviewDocumentFileBodiesOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<Response> {
        let metrics = context.metrics;
        let Some(lease) = measure_git_review_phase_sync(metrics, Phase::Resolve, || {
            self.registry
                .acquire(&options.project_path, &options.document_id)
        }) else {
            return Ok(Response::DocumentExpired {
                document_id: options.document_id.clone(),
                message: "This review expired. Refresh it to load the latest diff.".into(),
            });
        };
        let document = &lease.document;
        let requested_paths: Vec<_> = options
            .files
            .iter()
            .cloned()
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect();
        let requested_files: Vec<&RegisteredGitReviewFile> =
            measure_git_review_phase_sync(metrics, Phase::Resolve, || {
                requested_paths
                    .iter()
                    .map(|path| {
                        document.files_by_path.get(path).ok_or_else(|| {
                            GitDomainError::new(
                                "INVALID_INPUT",
                                format!("The review does not contain {path}."),
                            )
                        })
                    })
                    .collect::<Result<_, _>>()
            })?;
        let mutable = matches!(
            document.source,
            Source::Workbench { .. } | Source::ComparisonWorkingTree { .. }
        );
        let freshness_paths: Vec<_> = requested_files
            .iter()
            .flat_map(|file| {
                std::iter::once(&file.path)
                    .chain(file.original_path.iter().filter(|path| !path.is_empty()))
                    .cloned()
            })
            .collect();
        let expected = if mutable {
            expected_tokens(&document.working_path_tokens, &freshness_paths)?
        } else {
            IndexMap::new()
        };
        let scope = match document.source {
            Source::Workbench {
                mode: garcon_contract::git::GitReviewMode::Staged,
                ..
            } => WorkingPathScope::Index,
            _ => WorkingPathScope::WorkingTree,
        };
        let capture_tokens = || {
            capture_working_path_tokens(
                &document.repo_root,
                &freshness_paths,
                WorkingPathTokenInputs {
                    scope,
                    ..Default::default()
                },
                context.signal.cloned(),
            )
        };
        if mutable {
            let before =
                measure_git_review_phase(metrics, Phase::FreshnessBefore, capture_tokens).await?;
            let changed_paths = changed_working_path_tokens(&expected, &before);
            if !changed_paths.is_empty() {
                return Ok(Response::Stale {
                    document_id: options.document_id.clone(),
                    changed_paths,
                    message:
                        "The requested files changed. Refresh the review to load the latest diff."
                            .into(),
                });
            }
        }

        let mut cached: IndexMap<_, _> =
            measure_git_review_phase_sync(metrics, Phase::BodyCache, || {
                requested_paths
                    .iter()
                    .filter_map(|path| lease.get_body(path).map(|body| (path.clone(), body)))
                    .collect()
            });
        if let Some(metrics) = metrics {
            metrics.borrow_mut().cache_hits = Some(Number(cached.len() as f64));
        }
        let missing: Vec<_> = requested_files
            .into_iter()
            .filter(|file| !cached.contains_key(&file.path))
            .collect();
        if !missing.is_empty() {
            let totals = loaded_git_review_body_totals(cached.values());
            let loaded = load_review_diff_batches(document, &missing, context, totals).await?;
            if mutable {
                let after =
                    measure_git_review_phase(metrics, Phase::FreshnessAfter, capture_tokens)
                        .await?;
                let changed_paths = changed_working_path_tokens(&expected, &after);
                if !changed_paths.is_empty() {
                    return Ok(Response::Stale {
                        document_id: options.document_id.clone(), changed_paths,
                        message: "The requested files changed while the diff was loading. Refresh the review.".into(),
                    });
                }
            }
            let (mut cacheable, uncached): (Vec<_>, Vec<_>) =
                loaded.bodies.into_iter().partition(|body| {
                    body.body_state != GitReviewBodyState::Error
                        && !is_git_review_collection_limit_body(body)
                });
            lease.set_bodies(&mut cacheable)?;
            cached.extend(
                cacheable
                    .into_iter()
                    .chain(uncached)
                    .map(|body| (body.path.clone(), body)),
            );
        }

        encode_response(&options.document_id, requested_paths, cached, metrics)
    }
}

fn encode_response(
    document_id: &str,
    requested_paths: Vec<String>,
    mut cached: IndexMap<String, GitReviewFilePatchBody>,
    metrics: Option<&RefCell<GitReviewRouteMetrics>>,
) -> ExecutorResult<Response> {
    let mut encoded_bytes = serde_json::to_vec(&Response::Ready {
        document_id: document_id.into(),
        files: IndexMap::new(),
        errors: IndexMap::new(),
        deferred_files: requested_paths.clone(),
    })?
    .len();
    let bodies = limit_git_review_response_bodies(
        requested_paths
            .iter()
            .filter_map(|path| cached.shift_remove(path)),
    );
    let mut files = IndexMap::new();
    let mut errors = IndexMap::new();
    for body in bodies {
        if is_git_review_collection_limit_body(&body) {
            continue;
        }
        let path = &body.path;
        let mut entry_bytes = encoded_member_bytes(path, &body)?;
        if let Some(error) = &body.error {
            entry_bytes += encoded_member_bytes(path, error)?;
        }
        if encoded_bytes + entry_bytes > MAX_ENCODED_RESPONSE_BYTES {
            continue;
        }
        encoded_bytes += entry_bytes;
        if let Some(error) = &body.error {
            errors.insert(path.clone(), error.clone());
        }
        files.insert(path.clone(), body);
    }
    let single_request = requested_paths.len() == 1;
    let deferred_files: Vec<_> = requested_paths
        .into_iter()
        .filter(|path| !files.contains_key(path))
        .collect();
    if single_request && !deferred_files.is_empty() {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_RESULT_TOO_LARGE,
            "Git file response exceeds the result limit.",
        )
        .into());
    }
    files.sort_by(|left, _, right, _| compare_object_keys(left, right));
    errors.sort_by(|left, _, right, _| compare_object_keys(left, right));
    if let Some(metrics) = metrics {
        let mut metrics = metrics.borrow_mut();
        metrics.file_count = Some(Number(files.len() as f64));
        metrics.row_count = Some(Number(
            files.values().map(|body| body.rendered_row_count.0).sum(),
        ));
    }
    Ok(Response::Ready {
        document_id: document_id.into(),
        files,
        errors,
        deferred_files,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::timeout;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::git::temporary_index::TemporaryGitIndexEnvironment;

    #[tokio::test]
    async fn settles_cancelled_queued_prefetches_before_the_active_body_load_completes() {
        let operations = GitReviewDocumentOperations::new(Rc::new(GitReviewDocumentRegistry::new(
            Default::default(),
        )));
        let active = operations.prefetch.lock().await;
        let request = GitReviewDocumentFileBodiesOptions {
            project_path: "/not-opened".into(),
            document_id: "missing".into(),
            files: vec!["a.txt".into()],
            purpose: GitReviewBodyPurpose::Prefetch,
        };
        let temporary_index = TemporaryGitIndexEnvironment::default();
        let signal = CancellationToken::new();
        let context = GitReviewDiffBatchContext {
            trace: None,
            signal: Some(&signal),
            metrics: None,
            temporary_index: &temporary_index,
        };
        let queued = operations.get_review_document_file_bodies(&request, &context);
        tokio::pin!(queued);
        assert!(futures::poll!(&mut queued).is_pending());
        signal.cancel();
        assert_eq!(
            timeout(Duration::from_secs(1), queued)
                .await
                .unwrap()
                .unwrap_err()
                .to_string(),
            "The operation was aborted.",
        );
        let visible = GitReviewDocumentFileBodiesOptions {
            purpose: GitReviewBodyPurpose::Visible,
            ..request.clone()
        };
        let context = GitReviewDiffBatchContext {
            signal: None,
            ..context
        };
        assert!(matches!(
            timeout(
                Duration::from_secs(1),
                operations.get_review_document_file_bodies(&visible, &context)
            )
            .await
            .unwrap()
            .unwrap(),
            Response::DocumentExpired { .. }
        ));
        drop(active);
        assert!(matches!(
            operations
                .get_review_document_file_bodies(&request, &context)
                .await
                .unwrap(),
            Response::DocumentExpired { .. },
        ));
    }
}
