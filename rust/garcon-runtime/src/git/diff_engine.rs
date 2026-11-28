//! Ports server/runtime/git/diff-engine.ts.

use std::convert::Infallible;
use std::rc::Rc;
use std::sync::LazyLock;

use garcon_base::concurrency::map_with_concurrency_result;
use garcon_contract::git::{
    ChangeFacet, DiffStats, GIT_REVIEW_DOCUMENT_LIMITS as LIMITS,
    GitFileReviewCategory as Category, GitMutationResult, GitReviewBodyPurpose, GitReviewBodyState,
    GitReviewCollectionLimit, GitReviewDocumentFileBodiesOptions,
    GitReviewDocumentFileBodiesResponse, GitReviewDocumentSummary, GitReviewFileSummary,
    GitReviewLimitReason, GitReviewMode, GitStageMode, GitWorkbenchChangesTree,
    GitWorkbenchSnapshotOptions, GitWorkbenchSnapshotReady, GitWorkbenchSnapshotResponse,
    GitWorkbenchSnapshotTarget, GitWorkbenchSource, GitWorkbenchTreeStatsState, TreeNode,
    TreeNodeKind,
};
use garcon_contract::git_diagnostics::GitReviewRoutePhaseName as Phase;
use garcon_contract::git_execution::{
    ExecutionStageHunkOptions, ExecutionStageSelectionOptions, GitSelectionProof,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, collation::Collation, number_to_string, parse_int, path::native, trim};
use indexmap::{IndexMap, IndexSet};
use regress::Regex;
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::files::file_revision::{close_file, stat_path};

use super::diff_file_list::{NumstatMap, parse_numstat_z, parse_unmerged_paths};
use super::git_domain_error::GitDomainError;
use super::operation_context::assert_git_working_path;
use super::pathspecs::chunk_git_pathspecs;
use super::porcelain_status::{
    PorcelainStatusEntry, change_kind_for_status, has_index_change, has_work_tree_change,
};
use super::review_diff_batch::GitReviewDiffBatchContext;
use super::review_document_registry::{
    GitReviewDocumentRegistry, GitReviewDocumentSource, RegisterGitReviewDocumentInput,
    registered_workbench_file,
};
use super::review_document_service::GitReviewDocumentOperations;
use super::review_patch::category_for_path;
use super::review_performance::measure_git_review_phase_sync;
use super::run::{
    assert_git_repository, directory_accessible, is_binary_file, read_git_blob_prefix,
    read_only_git_options, resolve_path_within_project, run_git, run_git_with_stdin,
};
use super::types::GitCommandOptions;
use super::working_path_token::{WorkingPathScope, capture_working_path_tokens_from_observation};
use super::working_tree_observation::{
    GitWorkingTreeNotRepositoryError, capture_working_tree_observation, node_millis,
};

const GIT_EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_STATS: DiffStats = DiffStats {
    additions: Number(0.0),
    deletions: Number(0.0),
    is_binary: None,
};

fn facet(
    status: &str,
    path: &str,
    stats: Option<&DiffStats>,
    original_path: Option<&str>,
) -> Option<ChangeFacet> {
    if matches!(status, "" | " " | "!") {
        return None;
    }
    Some(ChangeFacet {
        status: status.into(),
        change_kind: change_kind_for_status(status),
        stats: stats.cloned().unwrap_or(ZERO_STATS),
        original_path: original_path
            .filter(|path| !path.is_empty())
            .map(str::to_owned),
        category: Some(category_for_path(path)),
    })
}

struct ChangeEntry<'a> {
    path: &'a str,
    index_status: String,
    work_tree_status: String,
    staged: Option<ChangeFacet>,
    unstaged: Option<ChangeFacet>,
}

impl<'a> ChangeEntry<'a> {
    fn new(entry: &'a PorcelainStatusEntry, working: &NumstatMap, cached: &NumstatMap) -> Self {
        let path = entry.path.trim_end_matches('/');
        let index_status = entry.index_status.to_string();
        let work_tree_status = entry.work_tree_status.to_string();
        let original_path = entry.original_path.as_deref();
        let staged = if has_index_change(&index_status) {
            facet(&index_status, path, cached.get(path), original_path)
        } else {
            None
        };
        let unstaged_status = if index_status == "?" {
            "?"
        } else {
            &work_tree_status
        };
        let unstaged = if has_work_tree_change(unstaged_status) {
            facet(unstaged_status, path, working.get(path), original_path)
        } else {
            None
        };
        Self {
            path,
            index_status,
            work_tree_status,
            staged,
            unstaged,
        }
    }
}

struct TreeBuilderNode {
    node: TreeNode,
    children: IndexMap<String, Self>,
}

fn insert_entry(
    level: &mut IndexMap<String, TreeBuilderNode>,
    segments: &[&str],
    parent: &str,
    entry: &ChangeEntry<'_>,
) {
    let Some((&name, rest)) = segments.split_first() else {
        return;
    };
    let node = level.entry(name.into()).or_insert_with(|| {
        let node = if rest.is_empty() {
            TreeNode::file(
                entry.path.into(),
                name.into(),
                entry.index_status.clone(),
                entry.work_tree_status.clone(),
                entry.staged.clone(),
                entry.unstaged.clone(),
            )
        } else {
            let path = if parent.is_empty() {
                name.into()
            } else {
                format!("{parent}/{name}")
            };
            TreeNode::directory(path, name.into())
        };
        TreeBuilderNode {
            node,
            children: IndexMap::new(),
        }
    });
    if !rest.is_empty() {
        if node.node.kind == TreeNodeKind::Directory {
            node.node
                .add_descendant_facets(entry.staged.as_ref(), entry.unstaged.as_ref());
            insert_entry(&mut node.children, rest, &node.node.path, entry);
        } else {
            let prefix = if parent.is_empty() {
                name.into()
            } else {
                format!("{parent}/{name}")
            };
            insert_entry(level, rest, &prefix, entry);
        }
    }
}

fn sorted_tree(map: IndexMap<String, TreeBuilderNode>) -> Vec<TreeNode> {
    let mut result: Vec<_> = map
        .into_values()
        .map(|TreeBuilderNode { mut node, children }| {
            if node.kind == TreeNodeKind::Directory {
                node.set_children(sorted_tree(children));
            }
            node
        })
        .collect();
    let collation = Collation::english();
    result.sort_by(|left, right| {
        (left.kind != TreeNodeKind::Directory)
            .cmp(&(right.kind != TreeNodeKind::Directory))
            .then_with(|| collation.compare(&left.name, &right.name))
    });
    result
}

fn build_tree(
    status: &[PorcelainStatusEntry],
    working: &NumstatMap,
    cached: &NumstatMap,
    has_commits: bool,
) -> GitWorkbenchChangesTree {
    let mut root = IndexMap::new();
    for entry in status {
        let entry = ChangeEntry::new(entry, working, cached);
        let segments: Vec<_> = entry
            .path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        insert_entry(&mut root, &segments, "", &entry);
    }
    GitWorkbenchChangesTree {
        root: sorted_tree(root),
        has_commits,
        stats_state: GitWorkbenchTreeStatsState::Loaded,
    }
}

fn hash_prefix(bytes: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")[..16].into()
}

async fn hash_file_prefix(file: &str) -> ExecutorResult<String> {
    assert_git_working_path(file).await?;
    let mut handle = File::open(file).await?;
    let mut buffer = vec![0; 65_536];
    let hash = handle
        .read(&mut buffer)
        .await
        .map(|count| hash_prefix(&buffer[..count]));
    close_file(handle).await?;
    Ok(hash?)
}

async fn worktree_fingerprint(project: &str, file: &str) -> String {
    let result: ExecutorResult<_> = async {
        let path = resolve_path_within_project(project, file)?;
        assert_git_working_path(&path).await?;
        let stats = stat_path(&path).await?;
        let size = number_to_string(stats.revision.size as f64);
        let mtime = node_millis(stats.revision.mtime_ns);
        if !stats.is_file {
            return Ok(format!("not-file:{size}:{}", number_to_string(mtime)));
        }
        let prefix = hash_file_prefix(&path).await?;
        Ok(format!(
            "file:{size}:{}:{prefix}",
            number_to_string(mtime.trunc())
        ))
    }
    .await;
    result.unwrap_or_else(|_| "missing".into())
}

fn parse_ls_tree_z(output: &str) -> impl Iterator<Item = (String, String)> + '_ {
    output.split('\0').filter_map(|token| {
        let (metadata, path) = token.split_once('\t')?;
        let object = metadata.split(' ').nth(2)?;
        (!path.is_empty() && !object.is_empty()).then(|| (path.into(), object.into()))
    })
}

fn readonly(signal: Option<&CancellationToken>) -> GitCommandOptions {
    read_only_git_options(GitCommandOptions {
        signal: signal.cloned(),
        ..Default::default()
    })
}

async fn load_head_entries(
    project: &str,
    files: &[&TreeNode],
    mode: GitReviewMode,
    signal: Option<&CancellationToken>,
) -> IndexMap<String, String> {
    let paths: Vec<_> = files.iter().map(|file| file.path.clone()).collect();
    let deleted: IndexSet<_> = files
        .iter()
        .filter(|file| mode == GitReviewMode::Working && file.work_tree_status == "D")
        .map(|file| file.path.as_str())
        .collect();
    let mut entries = IndexMap::new();
    for chunk in chunk_git_pathspecs(&paths) {
        let head_paths: Vec<_> = chunk
            .iter()
            .filter(|path| deleted.contains(path.as_str()))
            .cloned()
            .collect();
        if !head_paths.is_empty() {
            let args = ["ls-tree", "-rz", "HEAD", "--"]
                .map(str::to_owned)
                .into_iter()
                .chain(head_paths)
                .collect();
            if let Ok(output) = run_git(project, args, readonly(signal)).await {
                entries.extend(parse_ls_tree_z(&output.stdout));
            }
        }
    }
    entries
}

fn mode_text(mode: GitReviewMode) -> &'static str {
    match mode {
        GitReviewMode::Working => "working",
        GitReviewMode::Staged => "staged",
    }
}

async fn body_fingerprint(
    project: &str,
    node: &TreeNode,
    facet: &ChangeFacet,
    mode: GitReviewMode,
    index: &IndexMap<String, String>,
    head: &IndexMap<String, String>,
) -> String {
    let file = &node.path;
    let mut fields = vec![
        mode_text(mode),
        file,
        facet.original_path.as_deref().unwrap_or_default(),
        node.index_status.as_str(),
        node.work_tree_status.as_str(),
    ];
    let worktree;
    if mode == GitReviewMode::Staged || node.work_tree_status == "D" {
        fields.push(index.get(file).map_or("", String::as_str));
        if mode == GitReviewMode::Working {
            fields.push(head.get(file).map_or("", String::as_str));
        }
    } else {
        worktree = worktree_fingerprint(project, file).await;
        fields.push(&worktree);
    }
    hash_prefix(fields.join("\x1f"))
}

async fn is_summary_binary(
    project: &str,
    node: &TreeNode,
    mode: GitReviewMode,
    stats: &DiffStats,
    signal: Option<&CancellationToken>,
) -> bool {
    if stats.is_binary == Some(true) {
        return true;
    }
    let ambiguous = stats.additions.0 == 0.0 && stats.deletions.0 == 0.0;
    if mode == GitReviewMode::Staged {
        return node.index_status != "D"
            && ambiguous
            && read_git_blob_prefix(project, &format!(":{}", node.path), signal.cloned())
                .await
                .is_ok_and(|bytes| bytes.contains(&0));
    }
    if node.work_tree_status == "D"
        || (!ambiguous && node.index_status != "?" && node.work_tree_status != "?")
    {
        return false;
    }
    let result: ExecutorResult<_> = async {
        let path = resolve_path_within_project(project, &node.path)?;
        assert_git_working_path(&path).await?;
        Ok(stat_path(&path).await?.is_file && is_binary_file(&path).await)
    }
    .await;
    result.unwrap_or(false)
}

fn collect_review_files<'a>(
    tree: &'a [TreeNode],
    mode: GitReviewMode,
    files: &mut Vec<(&'a TreeNode, &'a ChangeFacet)>,
) {
    for node in tree {
        if node.kind == TreeNodeKind::File {
            let facet = if mode == GitReviewMode::Staged {
                &node.staged_facet
            } else {
                &node.unstaged_facet
            };
            if let Some(facet) = facet {
                files.push((node, facet));
            }
        } else if let Some(children) = &node.children {
            collect_review_files(children, mode, files);
        }
    }
}

async fn review_summary(
    project: &str,
    mode: GitReviewMode,
    context: u8,
    tree: &[TreeNode],
    index: &IndexMap<String, String>,
    unmerged: &IndexSet<&str>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitReviewDocumentSummary> {
    let mut review_files = Vec::new();
    collect_review_files(tree, mode, &mut review_files);
    let total = review_files.len();
    review_files.truncate(LIMITS.max_summary_files);
    let paths: Vec<_> = review_files.iter().map(|(file, _)| *file).collect();
    let head = load_head_entries(project, &paths, mode, signal).await;
    let head = &head;
    let summaries = map_with_concurrency_result(
        &review_files,
        LIMITS.body_concurrency as f64,
        |&(node, facet), _| async move {
            let stats = &facet.stats;
            let category = facet
                .category
                .or(node.category)
                .unwrap_or_else(|| category_for_path(&node.path));
            let is_binary = is_summary_binary(project, node, mode, stats, signal).await;
            let estimated = stats.additions.0 + stats.deletions.0 + 1.0;
            let estimated_rows = if estimated < 1.0 { 1.0 } else { estimated };
            let conflicted = unmerged.contains(node.path.as_str());
            let is_too_large =
                conflicted || (!is_binary && estimated_rows > LIMITS.max_file_rows as f64);
            let limit = if conflicted {
                Some((
                    GitReviewLimitReason::UnsupportedFileKind,
                    "Resolve this conflict before reviewing its diff.".into(),
                ))
            } else if is_too_large {
                Some((
                    GitReviewLimitReason::FileTooManyRows,
                    format!("Diff exceeds {} estimated rows.", LIMITS.max_file_rows),
                ))
            } else if is_binary {
                Some((
                    GitReviewLimitReason::Binary,
                    "Binary diff is not available.".into(),
                ))
            } else {
                None
            };
            let (limit_reason, limit_message) = limit.unzip();
            Ok::<_, Infallible>(GitReviewFileSummary {
                path: node.path.clone(),
                original_path: facet.original_path.clone(),
                index_status: node.index_status.clone(),
                work_tree_status: node.work_tree_status.clone(),
                category: if is_binary {
                    Category::Binary
                } else if is_too_large {
                    Category::Large
                } else {
                    category
                },
                additions: stats.additions,
                deletions: stats.deletions,
                stats_known: None,
                estimated_rows: Number(estimated_rows),
                body_state: if is_binary {
                    GitReviewBodyState::Binary
                } else if is_too_large {
                    GitReviewBodyState::TooLarge
                } else {
                    GitReviewBodyState::Unloaded
                },
                body_fingerprint: body_fingerprint(project, node, facet, mode, index, head).await,
                is_generated: category == Category::Generated,
                is_binary,
                is_too_large,
                limit_reason,
                limit_message,
            })
        },
    )
    .await?;
    let visible = summaries.len();
    let fields = [project.into(), mode_text(mode).into(), context.to_string()]
        .into_iter()
        .chain(
            summaries
                .iter()
                .map(|file| format!("{}:{}", file.path, file.body_fingerprint)),
        )
        .collect::<Vec<_>>();
    Ok(GitReviewDocumentSummary {
        document_id: hash_prefix(fields.join("\x1f")),
        project: project.into(),
        mode,
        context: Number(f64::from(context)),
        files: summaries,
        limits: LIMITS,
        collection_limit: (visible < total).then(|| GitReviewCollectionLimit {
            reason: GitReviewLimitReason::CollectionTooManyFiles,
            message: format!("Showing {visible} of {total} changed files."),
            visible_files: Number(visible as f64),
            total_files_known: Number(total as f64),
        }),
    })
}

fn first_body_candidates(
    files: &[GitReviewFileSummary],
    selected: Option<&str>,
    count: usize,
) -> Vec<String> {
    let mut seen = IndexSet::new();
    selected
        .and_then(|selected| files.iter().find(|file| file.path == selected))
        .into_iter()
        .chain(files)
        .filter(|file| file.body_state == GitReviewBodyState::Unloaded)
        .map(|file| file.path.as_str())
        .filter(|path| seen.insert(*path))
        .take(count)
        .map(str::to_owned)
        .collect()
}

pub fn not_repository_snapshot(project_path: &str) -> GitWorkbenchSnapshotResponse {
    GitWorkbenchSnapshotResponse::NotGitRepository {
        project: project_path.into(),
        target: (),
        tree: (),
        review_summary: (),
        selected_file: (),
        first_body_candidates: [],
        message: "Git is not initialized in this directory.".into(),
    }
}

pub struct DiffEngine {
    registry: Rc<GitReviewDocumentRegistry>,
    documents: GitReviewDocumentOperations,
}

impl DiffEngine {
    pub fn new(registry: Rc<GitReviewDocumentRegistry>) -> Self {
        Self {
            documents: GitReviewDocumentOperations::new(registry.clone()),
            registry,
        }
    }

    pub async fn get_workbench_snapshot(
        &self,
        options: &GitWorkbenchSnapshotOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<GitWorkbenchSnapshotResponse> {
        let project = &options.project_path;
        if !directory_accessible(project).await {
            return Ok(not_repository_snapshot(project));
        }
        let observation =
            match capture_working_tree_observation(project, None, context.trace, context.signal)
                .await
            {
                Ok(observation) => observation,
                Err(error) if error.is::<GitWorkingTreeNotRepositoryError>() => {
                    return Ok(not_repository_snapshot(project));
                }
                Err(error) => return Err(error),
            };
        let root = &observation.repo_root;
        let mode = options.mode;
        let tree = build_tree(
            &observation.status_entries,
            &parse_numstat_z(&observation.working_stats_output),
            &parse_numstat_z(&observation.cached_stats_output),
            !observation.head.is_empty(),
        );
        let mut summary = review_summary(
            project,
            mode,
            options.context,
            &tree.root,
            &observation.index_entries_by_path,
            &parse_unmerged_paths(&observation.unmerged_output),
            context.signal,
        )
        .await?;
        let paths: Vec<_> = summary
            .files
            .iter()
            .flat_map(|file| {
                std::iter::once(&file.path)
                    .chain(file.original_path.iter())
                    .cloned()
            })
            .collect();
        let working_path_tokens = capture_working_path_tokens_from_observation(
            root,
            &paths,
            &observation,
            if mode == GitReviewMode::Staged {
                WorkingPathScope::Index
            } else {
                WorkingPathScope::WorkingTree
            },
            context.signal.cloned(),
        )
        .await?;
        let document =
            measure_git_review_phase_sync(context.metrics, Phase::DocumentRegister, || {
                self.registry.register(RegisterGitReviewDocumentInput {
                    source_cache_key: format!(
                        "workbench:{root}:{}:{}",
                        mode_text(mode),
                        options.context
                    ),
                    project_path: project.clone(),
                    repo_root: root.clone(),
                    context: usize::from(options.context),
                    source: GitReviewDocumentSource::Workbench {
                        mode,
                        staged_base_hash: if observation.head.is_empty() {
                            GIT_EMPTY_TREE.into()
                        } else {
                            observation.head.clone()
                        },
                        fingerprint: observation.fingerprint.clone(),
                    },
                    files: summary
                        .files
                        .iter()
                        .map(registered_workbench_file)
                        .collect(),
                    working_path_tokens,
                })
            })?;
        summary.document_id = document.id.clone();
        let selected_file = options
            .selected_file
            .as_deref()
            .filter(|path| !path.is_empty() && summary.files.iter().any(|file| file.path == *path))
            .or_else(|| summary.files.first().map(|file| file.path.as_str()))
            .map(str::to_owned);
        let first_body_candidates = first_body_candidates(
            &summary.files,
            selected_file.as_deref(),
            usize::from(options.body_candidate_count.unwrap_or(8)).min(LIMITS.max_body_batch_files),
        );
        let label = native::basename(project);
        Ok(GitWorkbenchSnapshotResponse::Ready(Box::new(
            GitWorkbenchSnapshotReady {
                project: project.clone(),
                target: GitWorkbenchSnapshotTarget {
                    project_path: project.clone(),
                    repo_root: root.clone(),
                    worktree_path: root.clone(),
                    label: if label.is_empty() {
                        project.clone()
                    } else {
                        label
                    },
                    branch: observation.branch,
                    source: GitWorkbenchSource::ChatProject,
                },
                tree,
                review_summary: summary,
                selected_file,
                first_body_candidates,
                snapshot_id: document.id.clone(),
                workbench_fingerprint: observation.fingerprint,
            },
        )))
    }

    async fn displayed_patch(
        &self,
        target: &SelectionTarget<'_>,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<String> {
        let proof = target.proof;
        let document_id = &proof.document.document_id;
        if document_id.is_empty()
            || proof.body_fingerprint.is_empty()
            || proof.patch_digest.is_empty()
        {
            return Err(stale_document().into());
        }
        let lease = self
            .registry
            .acquire(target.project, document_id)
            .ok_or_else(stale_document)?;
        let expected_mode = if target.mode == GitStageMode::Stage {
            GitReviewMode::Working
        } else {
            GitReviewMode::Staged
        };
        if !matches!(lease.document.source, GitReviewDocumentSource::Workbench { mode, .. } if mode == expected_mode)
            || target.context_lines.map(usize::from) != Some(lease.document.context)
            || lease.document.patch_digest(target.file).as_deref() != Some(&proof.patch_digest)
        {
            return Err(stale_document().into());
        }
        let options = GitReviewDocumentFileBodiesOptions {
            project_path: target.project.into(),
            document_id: document_id.clone(),
            files: vec![target.file.into()],
            purpose: GitReviewBodyPurpose::Visible,
        };
        let response = self
            .documents
            .get_review_document_file_bodies(
                &options,
                &GitReviewDiffBatchContext {
                    trace: None,
                    signal: context.signal,
                    metrics: None,
                    temporary_index: context.temporary_index,
                },
            )
            .await?;
        let GitReviewDocumentFileBodiesResponse::Ready { mut files, .. } = response else {
            return Err(stale_document().into());
        };
        let body = files.shift_remove(target.file).ok_or_else(stale_document)?;
        if body.body_state != GitReviewBodyState::Loaded
            || body.body_fingerprint != proof.body_fingerprint
            || body.patch_digest.as_deref() != Some(&proof.patch_digest)
        {
            return Err(stale_document().into());
        }
        body.patch
            .filter(|patch| !patch.is_empty())
            .ok_or_else(|| stale_document().into())
    }

    pub async fn stage_selection(
        &self,
        options: &ExecutionStageSelectionOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<GitMutationResult> {
        let selected = &options.selection;
        let target = SelectionTarget {
            project: &selected.project_path,
            file: &selected.file,
            mode: selected.mode,
            context_lines: selected.context_lines,
            proof: &options.proof,
        };
        let patch = self.displayed_patch(&target, context).await?;
        assert_git_repository(target.project, None).await?;
        let transformed = selected_patch(
            target.file,
            target.mode,
            &patch,
            &selected.selection.line_indices,
        )?;
        apply_patch(target.project, target.mode, transformed).await
    }

    pub async fn stage_hunk(
        &self,
        options: &ExecutionStageHunkOptions,
        context: &GitReviewDiffBatchContext<'_>,
    ) -> ExecutorResult<GitMutationResult> {
        let selected = &options.hunk;
        let target = SelectionTarget {
            project: &selected.project_path,
            file: &selected.file,
            mode: selected.mode,
            context_lines: selected.context_lines,
            proof: &options.proof,
        };
        let patch = self.displayed_patch(&target, context).await?;
        assert_git_repository(target.project, None).await?;
        let single = hunk_patch(target.file, target.mode, &patch, selected.hunk_index)?;
        apply_patch(target.project, target.mode, single).await
    }
}

struct SelectionTarget<'a> {
    project: &'a str,
    file: &'a str,
    mode: GitStageMode,
    context_lines: Option<u8>,
    proof: &'a GitSelectionProof,
}

fn stale_document() -> GitDomainError {
    GitDomainError::new(
        "STALE_DOCUMENT",
        "The displayed patch changed. Refresh and select it again.",
    )
}

struct Hunk<'a> {
    header: &'a str,
    lines: Vec<&'a str>,
}

struct ParsedPatch<'a> {
    header: Vec<&'a str>,
    hunks: Vec<Hunk<'a>>,
}

fn parse_patch(patch: &str) -> ParsedPatch<'_> {
    let mut header = Vec::new();
    let mut hunks = Vec::new();
    let mut current: Option<Hunk<'_>> = None;
    for line in patch.strip_suffix('\n').unwrap_or(patch).split('\n') {
        if line.starts_with("diff --git ") {
            hunks.extend(current.take());
            header.push(line);
        } else if current.is_none()
            && [
                "index ",
                "new file",
                "deleted file",
                "---",
                "+++",
                "old mode",
                "new mode",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
        {
            header.push(line);
        } else if line.starts_with("@@") {
            hunks.extend(current.replace(Hunk {
                header: line,
                lines: Vec::new(),
            }));
        } else if let Some(current) = &mut current {
            current.lines.push(line);
        }
    }
    hunks.extend(current);
    ParsedPatch { header, hunks }
}

fn staging_header(file: &str, parsed: &ParsedPatch<'_>, mode: GitStageMode) -> String {
    if mode == GitStageMode::Stage
        && parsed
            .header
            .iter()
            .filter(|line| line.starts_with("diff --git "))
            .count()
            == 1
        && parsed
            .header
            .iter()
            .any(|line| line.starts_with("new file mode "))
    {
        return parsed.header.join("\n") + "\n";
    }
    format!("--- a/{file}\n+++ b/{file}\n")
}

fn transform_hunk_lines<'a>(
    lines: &[&'a str],
    selected: &IndexSet<u32>,
    index: &mut u32,
    reverse: bool,
) -> Vec<std::borrow::Cow<'a, str>> {
    let mut out = Vec::new();
    let mut dropped = false;
    for &line in lines {
        if line.starts_with('\\') {
            if !dropped {
                out.push(line.into());
            }
            continue;
        }
        let added = line.starts_with('+');
        let deleted = line.starts_with('-');
        if (!added && !deleted) || selected.contains(index) {
            out.push(line.into());
            dropped = false;
        } else if if reverse { added } else { deleted } {
            out.push(format!(" {}", &line[1..]).into());
            dropped = false;
        } else {
            dropped = true;
        }
        *index += 1;
    }
    out
}

static HUNK_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: constant JavaScript hunk-header pattern.
    Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$").expect("valid hunk-header pattern")
});

fn build_hunk_header(
    raw: &str,
    lines: &[std::borrow::Cow<'_, str>],
    start_offset: &mut f64,
) -> String {
    let Some(matched) = HUNK_HEADER.find(raw) else {
        return raw.into();
    };
    let Some(old_start) = matched
        .group(1)
        .and_then(|range| parse_int(&raw[range], 10))
    else {
        return raw.into();
    };
    let trailing = matched.group(3).map_or("", |range| &raw[range]);
    let (mut old, mut new) = (0, 0);
    for line in lines {
        if line.starts_with('\\') {
            continue;
        }
        old += usize::from(!line.starts_with('+'));
        new += usize::from(!line.starts_with('-'));
    }
    let adjustment = if old == 0 {
        1.0
    } else if new == 0 {
        -1.0
    } else {
        0.0
    };
    let new_start = old_start + *start_offset + adjustment;
    *start_offset += new as f64 - old as f64;
    format!(
        "@@ -{},{old} +{},{new} @@{trailing}",
        number_to_string(old_start),
        number_to_string(new_start)
    )
}

pub(super) fn selected_patch(
    file: &str,
    mode: GitStageMode,
    patch: &str,
    selection: &[u32],
) -> Result<String, GitDomainError> {
    if trim(patch).is_empty() {
        return Err(GitDomainError::new(
            "INVALID_INPUT",
            "No diff is available for the requested file.",
        ));
    }
    let parsed = parse_patch(patch);
    let selected: IndexSet<_> = selection.iter().copied().collect();
    let mut result = staging_header(file, &parsed, mode);
    let header_len = result.len();
    let mut offset = 0.0;
    let mut index = 0;
    for hunk in &parsed.hunks {
        let lines = transform_hunk_lines(
            &hunk.lines,
            &selected,
            &mut index,
            mode == GitStageMode::Unstage,
        );
        if !lines.iter().any(|line| line.starts_with(['+', '-'])) {
            continue;
        }
        result.push_str(&build_hunk_header(hunk.header, &lines, &mut offset));
        result.push('\n');
        for line in lines {
            result.push_str(&line);
            result.push('\n');
        }
    }
    if result.len() == header_len {
        Err(GitDomainError::new(
            "INVALID_INPUT",
            "No changed lines were selected.",
        ))
    } else {
        Ok(result)
    }
}

fn hunk_patch(
    file: &str,
    mode: GitStageMode,
    patch: &str,
    hunk_index: u32,
) -> Result<String, GitDomainError> {
    if trim(patch).is_empty() {
        return Err(GitDomainError::new(
            "INVALID_INPUT",
            "No diff is available for the requested target.",
        ));
    }
    let parsed = parse_patch(patch);
    let hunk = parsed.hunks.get(hunk_index as usize).ok_or_else(|| {
        GitDomainError::new("INVALID_INPUT", format!("Invalid hunk index {hunk_index}"))
    })?;
    let mut result = staging_header(file, &parsed, mode);
    result.push_str(hunk.header);
    result.push('\n');
    for line in &hunk.lines {
        result.push_str(line);
        result.push('\n');
    }
    Ok(result)
}

async fn apply_patch(
    project: &str,
    mode: GitStageMode,
    patch: String,
) -> ExecutorResult<GitMutationResult> {
    let mut args = vec!["apply".into(), "--cached".into()];
    if mode == GitStageMode::Unstage {
        args.push("--reverse".into());
    }
    args.push("-".into());
    run_git_with_stdin(project, args, patch, GitCommandOptions::default()).await?;
    Ok(GitMutationResult {
        success: true,
        output: None,
        output_truncated: None,
        message: None,
        remote_name: None,
        remote_branch: None,
        worktree_path: None,
    })
}
