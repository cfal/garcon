//! Ports `server/runtime/git/commit-history.ts`.

use std::cell::RefCell;

use garcon_contract::git::{
    GIT_REVIEW_DOCUMENT_LIMITS, GitCommitDetails, GitCommitFileStatus, GitCommitFileSummary,
    GitCommitParentOption, GitCommitSnapshotOptions, GitCommitSnapshotReady,
    GitCommitSnapshotResponse, GitFileReviewCategory, GitHistoryCommitListItem,
    GitHistoryCommitListOptions, GitHistoryCommitListResponse, GitReviewBodyState,
    GitReviewCollectionLimit, GitReviewLimitReason,
};
use garcon_contract::git_diagnostics::{GitReviewRouteMetrics, GitReviewRoutePhaseName};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, trim, trim_end, utf16};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::diff_file_list::{parse_name_status_z, parse_numstat_z};
use super::git_domain_error::GitDomainError;
use super::ref_validation::{assert_existing_commit_ref, assert_safe_ref};
use super::review_document_registry::{
    GitReviewDocumentRegistry, GitReviewDocumentSource, RegisterGitReviewDocumentInput,
    registered_tree_diff_file,
};
use super::review_patch::category_for_path;
use super::review_performance::measure_git_review_phase_sync;
use super::run::{assert_git_repository, read_only_git_options, run_git_traced_shared};
use super::types::{GitCommandOptions, GitCommandTrace};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_HISTORY_REF: &str = "HEAD";
const DEFAULT_HISTORY_LIMIT: u32 = 50;
const MAX_HISTORY_LIMIT: u32 = 200;

fn parse_decorations(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn short_hash(hash: &str) -> String {
    let mut short = utf16::truncate(hash, 7).to_owned();
    if utf16::char_code_at(hash, 7).is_some_and(|unit| (0xDC00..=0xDFFF).contains(&unit)) {
        short.push(char::REPLACEMENT_CHARACTER);
    }
    short
}

fn parse_parents(value: &str) -> Vec<String> {
    value
        .split(' ')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_commit_list(output: &str) -> Vec<GitHistoryCommitListItem> {
    output
        .split('\x1e')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let mut fields = entry.trim_matches('\n').split('\0');
            let mut next = || fields.next().unwrap_or_default();
            let hash = next();
            if trim(hash).is_empty() {
                return None;
            }
            let parents = parse_parents(next());
            let author = next().into();
            let author_email = next().into();
            let author_date = next().into();
            let committer = next().into();
            let committer_email = next().into();
            let committer_date = next().into();
            let refs = parse_decorations(next());
            Some(GitHistoryCommitListItem {
                hash: hash.into(),
                short_hash: short_hash(hash),
                parents,
                author,
                author_email,
                author_date,
                committer,
                committer_email,
                committer_date,
                subject: next().into(),
                refs,
            })
        })
        .collect()
}

fn parse_commit_details(output: &str) -> GitCommitDetails {
    let mut fields = output.splitn(11, '\0');
    let mut next = || fields.next().unwrap_or_default();
    let hash = next();
    let parents = parse_parents(next());
    let author = next().into();
    let author_email = next().into();
    let author_date = next().into();
    let committer = next().into();
    let committer_email = next().into();
    let committer_date = next().into();
    let refs = parse_decorations(next());
    GitCommitDetails {
        hash: hash.into(),
        short_hash: short_hash(hash),
        parents,
        author,
        author_email,
        author_date,
        committer,
        committer_email,
        committer_date,
        subject: next().into(),
        body: trim_end(next()).into(),
        refs,
    }
}

fn readonly(signal: Option<&CancellationToken>) -> GitCommandOptions {
    read_only_git_options(GitCommandOptions {
        signal: signal.cloned(),
        ..Default::default()
    })
}

async fn resolve_commit(
    project: &str,
    commit: &str,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> Result<Option<String>, GitDomainError> {
    assert_safe_ref(commit, "commit")?;
    let result = run_git_traced_shared(
        project,
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            format!("{commit}^{{commit}}"),
        ],
        trace,
        readonly(signal),
    )
    .await;
    Ok(result.ok().and_then(|output| {
        let result = trim(&output.stdout);
        (!result.is_empty()).then(|| result.to_owned())
    }))
}

async fn load_commit_details(
    project: &str,
    commit: &str,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitCommitDetails> {
    let output = run_git_traced_shared(
        project,
        [
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%D%x00%s%x00%b",
            commit,
        ]
        .map(str::to_owned)
        .into(),
        trace,
        readonly(signal),
    )
    .await?;
    Ok(parse_commit_details(&output.stdout))
}

fn select_commit_parent<'a>(
    parents: &'a [String],
    requested: Option<&'a str>,
) -> Result<Option<&'a str>, GitDomainError> {
    let requested = requested.filter(|parent| !parent.is_empty());
    let Some(first) = parents.first() else {
        return if requested.is_some() {
            Err(GitDomainError::new(
                "INVALID_INPUT",
                "Root commits do not have parent diffs.",
            ))
        } else {
            Ok(None)
        };
    };
    let Some(requested) = requested else {
        return Ok(Some(first));
    };
    assert_safe_ref(requested, "parent")?;
    if !parents.iter().any(|parent| parent == requested) {
        return Err(GitDomainError::new(
            "INVALID_INPUT",
            "Requested parent is not a direct parent of the commit.",
        ));
    }
    Ok(Some(requested))
}

pub(super) fn status_from_raw(raw_status: &str) -> GitCommitFileStatus {
    use GitCommitFileStatus::{Added, Copied, Deleted, Modified, Renamed, TypeChanged, Unknown};
    match raw_status.as_bytes().first() {
        Some(b'A') => Added,
        Some(b'M') => Modified,
        Some(b'D') => Deleted,
        Some(b'R') => Renamed,
        Some(b'C') => Copied,
        Some(b'T') => TypeChanged,
        _ => Unknown,
    }
}

fn commit_file_fingerprint(
    commit: &str,
    parent: Option<&str>,
    context: usize,
    file: &GitCommitFileSummary,
) -> String {
    let key = [
        "commit-file",
        commit,
        parent.unwrap_or(EMPTY_TREE),
        &context.to_string(),
        file.original_path.as_deref().unwrap_or_default(),
        &file.path,
    ]
    .join("\x1f");
    let mut digest = format!("{:x}", Sha256::digest(key));
    digest.truncate(16);
    digest
}

fn summarize_commit_files(
    commit: &str,
    parent: Option<&str>,
    context: usize,
    name_status: &str,
    numstat: &str,
) -> Vec<GitCommitFileSummary> {
    parse_name_status_z(name_status, &parse_numstat_z(numstat))
        .into_iter()
        .map(|file| {
            let is_binary = file.is_binary == Some(true);
            let category = if is_binary {
                GitFileReviewCategory::Binary
            } else {
                category_for_path(&file.path)
            };
            let rows = (file.additions.0 + file.deletions.0 + 1.0).max(1.0);
            let is_too_large = !is_binary && rows > GIT_REVIEW_DOCUMENT_LIMITS.max_file_rows as f64;
            let (body_state, limit_reason, limit_message) = if is_binary {
                (
                    GitReviewBodyState::Binary,
                    Some(GitReviewLimitReason::Binary),
                    Some("Binary diff is not available.".into()),
                )
            } else if is_too_large {
                (
                    GitReviewBodyState::TooLarge,
                    Some(GitReviewLimitReason::FileTooManyRows),
                    Some(format!(
                        "Diff exceeds {} estimated rows.",
                        GIT_REVIEW_DOCUMENT_LIMITS.max_file_rows
                    )),
                )
            } else {
                (GitReviewBodyState::Unloaded, None, None)
            };
            let mut summary = GitCommitFileSummary {
                path: file.path,
                original_path: file.original_path,
                status: status_from_raw(&file.status),
                raw_status: file.status,
                category: if is_too_large {
                    GitFileReviewCategory::Large
                } else {
                    category
                },
                additions: file.additions,
                deletions: file.deletions,
                stats_known: None,
                estimated_rows: Number(rows),
                body_state,
                body_fingerprint: String::new(),
                is_generated: category == GitFileReviewCategory::Generated,
                is_binary,
                is_too_large,
                limit_reason,
                limit_message,
            };
            summary.body_fingerprint = commit_file_fingerprint(commit, parent, context, &summary);
            summary
        })
        .collect()
}

pub async fn get_history_commits(
    request: &GitHistoryCommitListOptions,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitHistoryCommitListResponse> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    let reference = request
        .reference
        .as_deref()
        .filter(|reference| !reference.is_empty())
        .unwrap_or(DEFAULT_HISTORY_REF);
    let limit = request
        .limit
        .filter(|&limit| limit > 0)
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .min(MAX_HISTORY_LIMIT);
    let offset = request.offset.unwrap_or(0);
    if let Err(error) =
        assert_existing_commit_ref(project, reference, "history", signal.cloned()).await
    {
        if reference == DEFAULT_HISTORY_REF {
            return Ok(GitHistoryCommitListResponse {
                project: project.clone(),
                reference: reference.into(),
                commits: Vec::new(),
                next_offset: None,
            });
        }
        return Err(error.into());
    }
    let output = run_git_traced_shared(
        project,
        vec![
            "log".into(),
            "--date=iso-strict".into(),
            format!("-n{limit}"),
            format!("--skip={offset}"),
            "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%D%x00%s%x1e".into(),
            reference.into(),
        ],
        trace,
        readonly(signal),
    )
    .await?;
    let commits = parse_commit_list(&output.stdout);
    let next_offset =
        (commits.len() == limit as usize).then(|| Number(f64::from(offset) + commits.len() as f64));
    Ok(GitHistoryCommitListResponse {
        project: project.clone(),
        reference: reference.into(),
        commits,
        next_offset,
    })
}

pub async fn get_commit_snapshot(
    request: &GitCommitSnapshotOptions,
    registry: &GitReviewDocumentRegistry,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    metrics: Option<&RefCell<GitReviewRouteMetrics>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitCommitSnapshotResponse> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    let Some(commit) = resolve_commit(project, &request.commit, trace, signal).await? else {
        return Ok(GitCommitSnapshotResponse::NotFound {
            project: project.clone(),
            commit: request.commit.clone(),
            message: "Commit was not found in this repository.".into(),
        });
    };
    let details = load_commit_details(project, &commit, trace, signal).await?;
    let selected_parent = select_commit_parent(&details.parents, request.parent.as_deref())?;
    let base = selected_parent.unwrap_or(EMPTY_TREE);
    let diff_args = |kind| {
        [
            "diff",
            kind,
            "-z",
            "--find-renames",
            base,
            details.hash.as_str(),
        ]
        .map(str::to_owned)
        .into()
    };
    let (names, numstat) = tokio::try_join!(biased;
        run_git_traced_shared(project, diff_args("--name-status"), trace, readonly(signal)),
        run_git_traced_shared(project, diff_args("--numstat"), trace, readonly(signal)),
    )?;
    let context = usize::from(request.context.unwrap_or(5));
    let mut files = summarize_commit_files(
        &details.hash,
        selected_parent,
        context,
        &names.stdout,
        &numstat.stdout,
    );
    let total = files.len();
    files.truncate(GIT_REVIEW_DOCUMENT_LIMITS.max_summary_files);
    let document =
        measure_git_review_phase_sync(metrics, GitReviewRoutePhaseName::DocumentRegister, || {
            registry.register(RegisterGitReviewDocumentInput {
                source_cache_key: format!("commit:{project}:{}:{base}:{context}", details.hash),
                project_path: project.clone(),
                repo_root: project.clone(),
                context,
                source: GitReviewDocumentSource::Commit {
                    base_hash: base.into(),
                    target_hash: details.hash.clone(),
                },
                files: files.iter().map(registered_tree_diff_file).collect(),
                working_path_tokens: Default::default(),
            })
        })?;
    let visible = files.len();
    let count = usize::from(request.body_candidate_count.unwrap_or(8))
        .min(GIT_REVIEW_DOCUMENT_LIMITS.max_body_batch_files);
    let first_body_candidates = files
        .iter()
        .filter(|file| file.body_state == GitReviewBodyState::Unloaded)
        .take(count)
        .map(|file| file.path.clone())
        .collect();
    let parent_options = details
        .parents
        .iter()
        .enumerate()
        .map(|(index, hash)| GitCommitParentOption {
            hash: hash.clone(),
            short_hash: short_hash(hash),
            label: format!("Parent {}", index + 1),
        })
        .collect();
    Ok(GitCommitSnapshotResponse::Ready(Box::new(
        GitCommitSnapshotReady {
            project: project.clone(),
            document_id: document.id.clone(),
            selected_parent: selected_parent.map(str::to_owned),
            commit: details,
            parent_options,
            files,
            limits: GIT_REVIEW_DOCUMENT_LIMITS,
            collection_limit: (total > visible).then(|| GitReviewCollectionLimit {
                reason: GitReviewLimitReason::CollectionTooManyFiles,
                message: format!("Showing {visible} of {total} changed files."),
                visible_files: Number(visible as f64),
                total_files_known: Number(total as f64),
            }),
            first_body_candidates,
        },
    )))
}
