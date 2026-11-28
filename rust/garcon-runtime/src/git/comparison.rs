//! Ports server/runtime/git/comparison.ts.

use std::rc::Rc;

use garcon_contract::git::{
    GIT_REVIEW_DOCUMENT_LIMITS as LIMITS, GitCommitFileStatus as Status, GitCommitFileSummary,
    GitComparisonEndpointSide as Side, GitComparisonFreshnessOptions,
    GitComparisonFreshnessResponse, GitComparisonFreshnessTo, GitComparisonFreshnessToExpectation,
    GitComparisonMode, GitComparisonRevisionKind, GitComparisonSnapshotOptions,
    GitComparisonSnapshotReady, GitComparisonSnapshotResponse, GitComparisonToEndpoint,
    GitFileReviewCategory as Category, GitResolvedComparisonRevision, GitResolvedComparisonTo,
    GitReviewBodyState, GitReviewCollectionLimit, GitReviewLimitReason,
};
use garcon_contract::git_diagnostics::GitReviewRoutePhaseName as Phase;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, collation::Collation, trim};
use indexmap::{IndexMap, IndexSet};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::cancellation::check_cancelled;

use super::comparison_errors::{
    is_expected_missing_git_result, is_unresolved_revision, needs_revision_failure_diagnostics,
};
use super::diff_file_list::{
    ParsedDiffFile, parse_name_status_z, parse_numstat_z, parse_unmerged_paths,
};
use super::git_domain_error::GitDomainError;
use super::porcelain_status::parse_porcelain_v1_z;
use super::ref_validation::assert_safe_ref;
use super::review_diff_batch::GitReviewDiffBatchContext;
use super::review_document_registry::{
    GitReviewDocumentRegistry, GitReviewDocumentSource, RegisterGitReviewDocumentInput,
    registered_tree_diff_file,
};
use super::review_patch::category_for_path;
use super::review_performance::measure_git_review_phase_sync;
use super::run::{assert_git_repository, read_only_git_options, run_git_traced_shared};
use super::types::{GitCommandOptions, GitCommandResult};
use super::working_path_token::{WorkingPathScope, capture_working_path_tokens_from_observation};
use super::working_tree_comparison::{create_untracked_summary_budget, summarize_untracked_file};
use super::working_tree_observation::{
    capture_working_tree_observation, is_working_tree_observation_current,
};
use super::worktrees::ProjectPathAllowed;

pub const GIT_EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn status_from_raw(status: &str) -> Status {
    match status.as_bytes().first() {
        Some(b'A' | b'?') => Status::Added,
        Some(b'M' | b'U') => Status::Modified,
        Some(b'D') => Status::Deleted,
        Some(b'R') => Status::Renamed,
        Some(b'C') => Status::Copied,
        Some(b'T') => Status::TypeChanged,
        _ => Status::Unknown,
    }
}

fn resolved_revision(revision: &str, label: &str, hash: String) -> GitResolvedComparisonRevision {
    let mut short_hash = garcon_js::utf16::truncate(&hash, 7).to_owned();
    if garcon_js::utf16::char_code_at(&hash, 7)
        .is_some_and(|unit| (0xDC00..=0xDFFF).contains(&unit))
    {
        short_hash.push(char::REPLACEMENT_CHARACTER);
    }
    GitResolvedComparisonRevision {
        kind: GitComparisonRevisionKind::Revision,
        requested_revision: revision.into(),
        label: label.into(),
        short_hash,
        hash,
    }
}

async fn resolve_revision(
    project: &str,
    revision: &str,
    context: &GitReviewDiffBatchContext<'_>,
) -> ExecutorResult<Option<GitResolvedComparisonRevision>> {
    match assert_safe_ref(revision, "revision") {
        Err(error) if error.code == "INVALID_INPUT" => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(()) => (),
    }
    if revision == GIT_EMPTY_TREE {
        return Ok(Some(resolved_revision(
            revision,
            "Empty tree",
            revision.into(),
        )));
    }
    let resolve = |quiet| {
        let mut args = vec!["rev-parse".into(), "--verify".into()];
        if quiet {
            args.push("--quiet".into());
        }
        args.push(format!("{revision}^{{commit}}"));
        read_git(project, args, context)
    };
    let result = match resolve(true).await {
        Ok(result) => result,
        Err(error) if is_unresolved_revision(error.as_ref()) => return Ok(None),
        Err(error) if needs_revision_failure_diagnostics(error.as_ref()) => {
            match resolve(false).await {
                Err(error) if is_unresolved_revision(error.as_ref()) => return Ok(None),
                result => result?,
            }
        }
        Err(error) => return Err(error),
    };
    let hash = trim(&result.stdout);
    Ok((!hash.is_empty()).then(|| resolved_revision(revision, revision, hash.into())))
}

async fn read_git(
    project: &str,
    args: Vec<String>,
    context: &GitReviewDiffBatchContext<'_>,
) -> ExecutorResult<GitCommandResult> {
    run_git_traced_shared(
        project,
        args,
        context.trace,
        read_only_git_options(GitCommandOptions {
            signal: context.signal.cloned(),
            ..Default::default()
        }),
    )
    .await
}

async fn find_merge_base(
    project: &str,
    from: &str,
    to: &str,
    context: &GitReviewDiffBatchContext<'_>,
) -> ExecutorResult<Option<String>> {
    match read_git(
        project,
        vec!["merge-base".into(), from.into(), to.into()],
        context,
    )
    .await
    {
        Ok(output) => {
            let hash = trim(&output.stdout);
            Ok((!hash.is_empty()).then(|| hash.to_owned()))
        }
        Err(error) if is_expected_missing_git_result(error.as_ref()) => Ok(None),
        Err(error) => Err(error),
    }
}

struct DiffOutput {
    names: String,
    stats: String,
}

async fn load_diff_summary(
    root: &str,
    from: &str,
    to: Option<&str>,
    context: &GitReviewDiffBatchContext<'_>,
) -> ExecutorResult<DiffOutput> {
    let read_diff = |kind: &str| {
        let args = ["diff", kind, "-z", "--find-renames", from]
            .into_iter()
            .chain(to)
            .map(str::to_owned)
            .collect();
        read_git(root, args, context)
    };
    let (names, stats) =
        tokio::try_join!(biased; read_diff("--name-status"), read_diff("--numstat"))?;
    Ok(DiffOutput {
        names: names.stdout,
        stats: stats.stdout,
    })
}

struct ComparedFiles {
    summaries: Vec<GitCommitFileSummary>,
    total: usize,
}

impl ComparedFiles {
    fn collection_limit(&self) -> Option<GitReviewCollectionLimit> {
        let visible = self.summaries.len();
        let total = self.total;
        (visible < total).then(|| GitReviewCollectionLimit {
            reason: GitReviewLimitReason::CollectionTooManyFiles,
            message: format!("Showing {visible} of {total} changed files."),
            visible_files: Number(visible as f64),
            total_files_known: Number(total as f64),
        })
    }
}

struct SummaryInputs<'a> {
    project: &'a str,
    from: &'a str,
    target: &'a str,
    context: u8,
    status: &'a str,
    unmerged: &'a str,
    signal: Option<&'a CancellationToken>,
}

async fn summarize_files(
    diff: DiffOutput,
    inputs: SummaryInputs<'_>,
) -> ExecutorResult<ComparedFiles> {
    let mut files = parse_name_status_z(&diff.names, &parse_numstat_z(&diff.stats));
    let mut seen: IndexSet<_> = files.iter().map(|file| file.path.clone()).collect();
    for entry in parse_porcelain_v1_z(inputs.status) {
        if entry.index_status == '?' && seen.insert(entry.path.clone()) {
            files.push(ParsedDiffFile {
                path: entry.path,
                status: "?".into(),
                original_path: None,
                additions: Number(0.0),
                deletions: Number(0.0),
                is_binary: None,
            });
        }
    }
    let collation = Collation::english();
    files.sort_by(|left, right| collation.compare(&left.path, &right.path));
    let total = files.len();
    files.truncate(LIMITS.max_summary_files);
    let unmerged = parse_unmerged_paths(inputs.unmerged);
    let mut summaries = Vec::with_capacity(files.len());
    let mut budget = create_untracked_summary_budget();
    // Sorted admission keeps the shared untracked-byte budget independent of I/O timing.
    for file in files {
        check_cancelled(inputs.signal)?;
        let untracked = if file.status == "?" {
            Some(
                summarize_untracked_file(inputs.project, &file.path, &mut budget, inputs.signal)
                    .await?,
            )
        } else {
            None
        };
        let conflicted = unmerged.contains(file.path.as_str());
        let binary = file.is_binary == Some(true) || untracked.is_some_and(|file| file.is_binary);
        let additions = untracked.map_or(file.additions.0, |file| file.additions as f64);
        let estimated = additions + file.deletions.0 + 1.0;
        let estimated_rows = if estimated < 1.0 { 1.0 } else { estimated };
        let file_too_many_bytes = untracked.is_some_and(|file| file.is_too_large);
        let too_large =
            !binary && (file_too_many_bytes || estimated_rows > LIMITS.max_file_rows as f64);
        let unsupported = untracked.is_some_and(|file| file.unsupported);
        let category = category_for_path(&file.path);
        let limit = if conflicted {
            Some((
                GitReviewLimitReason::UnsupportedFileKind,
                "Resolve this conflict before reviewing its comparison diff.".into(),
            ))
        } else if unsupported {
            Some((
                GitReviewLimitReason::UnsupportedFileKind,
                "Only regular untracked files can be displayed.".into(),
            ))
        } else if binary {
            Some((
                GitReviewLimitReason::Binary,
                "Binary diff is not available.".into(),
            ))
        } else if too_large {
            Some(if file_too_many_bytes {
                (
                    GitReviewLimitReason::FileTooManyBytes,
                    format!(
                        "File exceeds {} byte display limit.",
                        LIMITS.max_file_patch_bytes
                    ),
                )
            } else {
                (
                    GitReviewLimitReason::FileTooManyRows,
                    format!("Diff exceeds {} estimated rows.", LIMITS.max_file_rows),
                )
            })
        } else {
            None
        };
        let limited = too_large || conflicted || unsupported;
        let original_path = file.original_path.filter(|path| !path.is_empty());
        let fingerprint_input = [
            "comparison-file",
            inputs.from,
            inputs.target,
            &inputs.context.to_string(),
            original_path.as_deref().unwrap_or(""),
            &file.path,
        ]
        .join("\x1f");
        let digest = Sha256::digest(fingerprint_input);
        let (limit_reason, limit_message) = limit.unzip();
        summaries.push(GitCommitFileSummary {
            path: file.path,
            original_path,
            status: status_from_raw(&file.status),
            raw_status: file.status,
            category: if binary {
                Category::Binary
            } else if limited {
                Category::Large
            } else {
                category
            },
            additions: Number(additions),
            deletions: file.deletions,
            stats_known: untracked.filter(|file| !file.stats_known).map(|_| false),
            estimated_rows: Number(estimated_rows),
            body_state: if binary {
                GitReviewBodyState::Binary
            } else if limited {
                GitReviewBodyState::TooLarge
            } else {
                GitReviewBodyState::Unloaded
            },
            body_fingerprint: format!("{digest:x}")[..16].into(),
            is_generated: category == Category::Generated,
            is_binary: binary,
            is_too_large: limited,
            limit_reason,
            limit_message,
        });
    }
    Ok(ComparedFiles { summaries, total })
}

fn first_body_candidates(files: &[GitCommitFileSummary], count: usize) -> Vec<String> {
    files
        .iter()
        .filter(|file| file.body_state == GitReviewBodyState::Unloaded)
        .take(count)
        .map(|file| file.path.clone())
        .collect()
}

fn no_merge_base(
    project: &str,
    from: GitResolvedComparisonRevision,
    to: GitResolvedComparisonRevision,
) -> GitComparisonSnapshotResponse {
    GitComparisonSnapshotResponse::NoMergeBase {
        project: project.into(),
        from,
        to,
        message: "These revisions do not have a common ancestor.".into(),
    }
}

fn missing_endpoint(side: Side, freshness: bool) -> &'static str {
    match (side, freshness) {
        (Side::From, false) => "The From revision was not found in this repository.",
        (Side::From, true) => "The From revision is no longer available in this repository.",
        (Side::To, false) => "The To revision was not found in this repository.",
        (Side::To, true) => "The To revision is no longer available in this repository.",
    }
}

pub struct ComparisonOperations {
    registry: Rc<GitReviewDocumentRegistry>,
    allowed: Option<Rc<dyn ProjectPathAllowed>>,
}

impl ComparisonOperations {
    pub fn new(
        registry: Rc<GitReviewDocumentRegistry>,
        allowed: Option<Rc<dyn ProjectPathAllowed>>,
    ) -> Self {
        Self { registry, allowed }
    }

    async fn resolve_root(
        &self,
        project: &str,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<String> {
        assert_git_repository(project, None).await?;
        let output = read_git(
            project,
            ["rev-parse", "--show-toplevel"].map(str::to_owned).to_vec(),
            context,
        )
        .await?;
        let stdout = trim(&output.stdout);
        let root = if stdout.is_empty() { project } else { stdout };
        match &self.allowed {
            Some(allowed) => allowed.assert_project_path_allowed(root).await,
            None => Ok(root.into()),
        }
    }

    pub async fn get_comparison_snapshot(
        &self,
        request: &GitComparisonSnapshotOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<GitComparisonSnapshotResponse> {
        let project = &request.project_path;
        let root = self.resolve_root(project, context).await?;
        let context_lines = request
            .context
            .unwrap_or(5)
            .min(LIMITS.max_context_lines as u8);
        let candidate_count =
            usize::from(request.body_candidate_count.unwrap_or(8)).min(LIMITS.max_body_batch_files);
        let Some(from) = resolve_revision(&root, &request.from.revision, context).await? else {
            return Ok(GitComparisonSnapshotResponse::NotFound {
                project: project.clone(),
                endpoint: Side::From,
                revision: request.from.revision.clone(),
                message: missing_endpoint(Side::From, false).into(),
            });
        };
        let GitComparisonToEndpoint::Revision { revision } = &request.to else {
            if request.mode != GitComparisonMode::Direct {
                return Err(GitDomainError::new(
                    "INVALID_INPUT",
                    "Working Tree comparisons require direct mode.",
                )
                .into());
            }
            return self
                .working_tree(project, root, from, context_lines, candidate_count, context)
                .await;
        };
        let Some(to) = resolve_revision(&root, revision, context).await? else {
            return Ok(GitComparisonSnapshotResponse::NotFound {
                project: project.clone(),
                endpoint: Side::To,
                revision: revision.clone(),
                message: missing_endpoint(Side::To, false).into(),
            });
        };
        let merge_base = if request.mode == GitComparisonMode::MergeBase {
            if from.hash == GIT_EMPTY_TREE || to.hash == GIT_EMPTY_TREE {
                return Ok(no_merge_base(project, from, to));
            }
            let Some(base) = find_merge_base(&root, &from.hash, &to.hash, context).await? else {
                return Ok(no_merge_base(project, from, to));
            };
            Some(base)
        } else {
            None
        };
        let effective_from = merge_base.as_deref().unwrap_or(&from.hash);
        let compared = summarize_files(
            load_diff_summary(&root, effective_from, Some(&to.hash), context).await?,
            SummaryInputs {
                project: &root,
                from: effective_from,
                target: &to.hash,
                context: context_lines,
                status: "",
                unmerged: "",
                signal: context.signal,
            },
        )
        .await?;
        check_cancelled(context.signal)?;
        let mode = if request.mode == GitComparisonMode::MergeBase {
            "merge-base"
        } else {
            "direct"
        };
        let document =
            measure_git_review_phase_sync(context.metrics, Phase::DocumentRegister, || {
                self.registry.register(RegisterGitReviewDocumentInput {
                    source_cache_key: format!(
                        "comparison:{root}:{mode}:{effective_from}:{}:{context_lines}",
                        to.hash
                    ),
                    project_path: project.clone(),
                    repo_root: root.clone(),
                    context: usize::from(context_lines),
                    source: GitReviewDocumentSource::ComparisonRevisions {
                        effective_from_hash: effective_from.into(),
                        to_hash: to.hash.clone(),
                    },
                    files: compared
                        .summaries
                        .iter()
                        .map(registered_tree_diff_file)
                        .collect(),
                    working_path_tokens: IndexMap::new(),
                })
            })?;
        Ok(GitComparisonSnapshotResponse::Ready(Box::new(
            GitComparisonSnapshotReady {
                project: project.clone(),
                repo_root: root,
                document_id: document.id.clone(),
                mode: request.mode,
                effective_from_hash: effective_from.into(),
                merge_base_hash: merge_base,
                from,
                to: GitResolvedComparisonTo::Revision {
                    requested_revision: to.requested_revision,
                    label: to.label,
                    hash: to.hash,
                    short_hash: to.short_hash,
                },
                limits: LIMITS,
                collection_limit: compared.collection_limit(),
                first_body_candidates: first_body_candidates(&compared.summaries, candidate_count),
                files: compared.summaries,
            },
        )))
    }

    async fn working_tree(
        &self,
        project: &str,
        root: String,
        from: GitResolvedComparisonRevision,
        context_lines: u8,
        candidate_count: usize,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<GitComparisonSnapshotResponse> {
        for _ in 0..2 {
            let (observation, diff) = tokio::join!(biased;
                capture_working_tree_observation(&root, Some(&root), context.trace, context.signal),
                load_diff_summary(&root, &from.hash, None, context),
            );
            let observation = observation?;
            let diff = match diff {
                Ok(diff) => diff,
                Err(error) => {
                    if context.signal.is_some_and(CancellationToken::is_cancelled)
                        || is_working_tree_observation_current(
                            &observation,
                            context.trace,
                            context.signal,
                        )
                        .await?
                    {
                        return Err(error);
                    }
                    continue;
                }
            };
            let before = &observation.fingerprint;
            let compared = summarize_files(
                diff,
                SummaryInputs {
                    project: &root,
                    from: &from.hash,
                    target: before,
                    context: context_lines,
                    status: &observation.status_output,
                    unmerged: &observation.unmerged_output,
                    signal: context.signal,
                },
            )
            .await?;
            let paths: Vec<_> = compared
                .summaries
                .iter()
                .flat_map(|file| {
                    std::iter::once(&file.path)
                        .chain(file.original_path.iter())
                        .cloned()
                })
                .collect();
            let tokens = capture_working_path_tokens_from_observation(
                &root,
                &paths,
                &observation,
                WorkingPathScope::WorkingTree,
                context.signal.cloned(),
            )
            .await?;
            if !is_working_tree_observation_current(&observation, context.trace, context.signal)
                .await?
            {
                continue;
            }
            let document =
                measure_git_review_phase_sync(context.metrics, Phase::DocumentRegister, || {
                    self.registry.register(RegisterGitReviewDocumentInput {
                        source_cache_key: format!(
                            "comparison:{root}:direct:{}:working-tree:{context_lines}",
                            from.hash
                        ),
                        project_path: project.into(),
                        repo_root: root.clone(),
                        context: usize::from(context_lines),
                        source: GitReviewDocumentSource::ComparisonWorkingTree {
                            effective_from_hash: from.hash.clone(),
                            fingerprint: before.clone(),
                        },
                        files: compared
                            .summaries
                            .iter()
                            .map(registered_tree_diff_file)
                            .collect(),
                        working_path_tokens: tokens,
                    })
                })?;
            return Ok(GitComparisonSnapshotResponse::Ready(Box::new(
                GitComparisonSnapshotReady {
                    project: project.into(),
                    repo_root: root,
                    document_id: document.id.clone(),
                    mode: GitComparisonMode::Direct,
                    effective_from_hash: from.hash.clone(),
                    merge_base_hash: None,
                    from,
                    to: GitResolvedComparisonTo::WorkingTree {
                        label: "Working Tree".into(),
                        branch: observation.branch,
                        head_hash: (!observation.head.is_empty()).then_some(observation.head),
                        short_fingerprint: before[before.len().saturating_sub(8)..].into(),
                        fingerprint: before.clone(),
                    },
                    limits: LIMITS,
                    collection_limit: compared.collection_limit(),
                    first_body_candidates: first_body_candidates(
                        &compared.summaries,
                        candidate_count,
                    ),
                    files: compared.summaries,
                },
            )));
        }
        Ok(GitComparisonSnapshotResponse::WorkingTreeChanging {
            project: project.into(), message: "The Working Tree changed while the comparison was loading. Try again when current edits settle.".into(),
        })
    }

    pub async fn get_comparison_freshness(
        &self,
        request: &GitComparisonFreshnessOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<GitComparisonFreshnessResponse> {
        let project = &request.project_path;
        let root = self.resolve_root(project, context).await?;
        assert_resolved_hash(&request.from.hash, "from.hash")?;
        if let GitComparisonFreshnessToExpectation::Revision { hash, .. } = &request.to {
            assert_resolved_hash(hash, "to.hash")?;
        }
        let missing = |side, revision: &str| GitComparisonFreshnessResponse::NotFound {
            project: project.clone(),
            endpoint: side,
            revision: revision.into(),
            message: missing_endpoint(side, true).into(),
        };
        let Some(from) = resolve_revision(&root, &request.from.revision, context).await? else {
            return Ok(missing(Side::From, &request.from.revision));
        };
        let mut changed = Vec::new();
        if from.hash != request.from.hash {
            changed.push(Side::From);
        }
        let to = match &request.to {
            GitComparisonFreshnessToExpectation::Revision { revision, hash } => {
                let Some(to) = resolve_revision(&root, revision, context).await? else {
                    return Ok(missing(Side::To, revision));
                };
                if &to.hash != hash {
                    changed.push(Side::To);
                }
                GitComparisonFreshnessTo::Revision { hash: to.hash }
            }
            GitComparisonFreshnessToExpectation::WorkingTree { fingerprint } => {
                let observation = capture_working_tree_observation(
                    &root,
                    Some(&root),
                    context.trace,
                    context.signal,
                )
                .await?;
                if &observation.fingerprint != fingerprint {
                    changed.push(Side::To);
                }
                GitComparisonFreshnessTo::WorkingTree {
                    fingerprint: observation.fingerprint,
                }
            }
        };
        Ok(GitComparisonFreshnessResponse::Ready {
            project: project.clone(),
            changed_endpoints: changed,
            from_hash: from.hash,
            to,
        })
    }
}

fn assert_resolved_hash(hash: &str, label: &str) -> Result<(), GitDomainError> {
    if !(40..=64).contains(&hash.len())
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(GitDomainError::new(
            "INVALID_INPUT",
            format!("{label} must be a resolved Git object hash."),
        ));
    }
    Ok(())
}
