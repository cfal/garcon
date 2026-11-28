//! Ports `server/runtime/git/worktrees.ts`.

use std::convert::Infallible;
use std::io::ErrorKind;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use garcon_base::concurrency::map_with_concurrency_result;
use garcon_base::log::{Logger, create_logger};
use garcon_contract::git::{
    CreateWorktreeOptions, GitMutationResult, GitTargetCandidatesResult,
    GitWorkbenchSnapshotTarget, GitWorkbenchSource, GitWorktreesResult, RemoveWorktreeOptions,
    RepoInfo, TargetCandidate, WorktreeInfo,
};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{path::native, to_iso_string, trim};
use indexmap::IndexSet;
use tokio::fs;

use super::ref_validation::{assert_existing_commit_ref, assert_safe_branch_name};
use super::run::{
    assert_git_repository, directory_accessible, read_only_git_options, run_git, run_git_traced,
};
use super::types::{GitCommandOptions, GitCommandTrace};
use super::worktree_admin::read_admin_worktree_records;
use super::worktree_layout::probe_worktree_layout;
use super::worktree_porcelain::read_porcelain_worktree_records;
use super::worktree_record::{WorktreeRecord, compare_worktree_paths};

const WORKTREE_STAT_CONCURRENCY: f64 = 32.0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WorktreeSource {
    #[default]
    Auto,
    Git,
}

#[async_trait(?Send)]
pub trait ProjectPathAllowed {
    async fn assert_project_path_allowed(&self, project_path: &str) -> ExecutorResult<String>;
}

#[derive(Default)]
pub struct WorktreeOperations {
    pub source: WorktreeSource,
    pub assert_project_path_allowed: Option<Rc<dyn ProjectPathAllowed>>,
}

pub fn serialize_worktree_mtime(epoch_ms: f64) -> Option<String> {
    if !epoch_ms.is_finite() || epoch_ms.abs() > 8.64e15 {
        return None;
    }
    to_iso_string(epoch_ms as i64).ok()
}

fn millis_since_epoch(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => {
            elapsed.as_secs() as f64 * 1000.0 + f64::from(elapsed.subsec_nanos()) / 1_000_000.0
        }
        Err(error) => {
            let duration = error.duration();
            -(duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1_000_000.0)
        }
    }
}

async fn enrich_worktree_metadata(path: &str) -> (bool, Option<String>) {
    if let Ok(metadata) = fs::metadata(path).await
        && metadata.is_dir()
        && let Ok(modified) = metadata.modified()
    {
        return (
            false,
            serialize_worktree_mtime(millis_since_epoch(modified)),
        );
    }
    (true, None)
}

fn readonly() -> GitCommandOptions {
    read_only_git_options(GitCommandOptions::default())
}

fn args<const N: usize>(argv: [&str; N]) -> Vec<String> {
    argv.map(str::to_owned).into()
}

fn current_directory() -> ExecutorResult<String> {
    Ok(std::env::current_dir()?.to_string_lossy().into_owned())
}

async fn is_registered_destination(project_path: &str, destination: &str) -> ExecutorResult<bool> {
    let registered = read_porcelain_worktree_records(project_path, None).await?;
    let cwd = current_directory()?;
    let paths: Vec<_> = registered
        .iter()
        .map(|worktree| native::resolve(&cwd, &[&worktree.path]))
        .collect();
    if paths.iter().any(|path| path == destination) {
        return Ok(true);
    }
    if !paths
        .iter()
        .any(|path| path.eq_ignore_ascii_case(destination))
    {
        return Ok(false);
    }
    let output = run_git(
        project_path,
        args([
            "config",
            "--type=bool",
            "--default=false",
            "--get",
            "core.ignoreCase",
        ]),
        readonly(),
    )
    .await?;
    Ok(trim(&output.stdout) == "true")
}

fn conflict(message: &str) -> GitServiceError {
    GitServiceError::new(GitServiceErrorCode::GIT_CONFLICT, message)
}

async fn assert_fresh_worktree_destination(
    project_path: &str,
    destination: &str,
) -> ExecutorResult<()> {
    if is_registered_destination(project_path, destination).await? {
        return Err(conflict("A worktree is already registered at this location.").into());
    }
    let mut directory = match fs::read_dir(destination).await {
        Ok(directory) => directory,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotADirectory => {
            return Err(conflict("The worktree location must be a directory.").into());
        }
        Err(error) => return Err(error.into()),
    };
    if directory.next_entry().await?.is_some() {
        return Err(conflict("The worktree location is not empty.").into());
    }
    Ok(())
}

fn normalize_worktree_records(
    mut records: Vec<WorktreeRecord>,
    project_path: &str,
) -> ExecutorResult<Vec<WorktreeInfo>> {
    let cwd = current_directory()?;
    let project = native::resolve(&cwd, &[project_path]);
    if records.len() >= 2 {
        records[1..].sort_by(compare_worktree_paths);
    }
    Ok(records
        .into_iter()
        .enumerate()
        .map(|(index, record)| WorktreeInfo {
            is_current: native::resolve(&cwd, &[&record.path]) == project,
            name: if record.name.is_empty() {
                native::basename(&record.path)
            } else {
                record.name
            },
            path: record.path,
            branch: record.branch,
            is_main: index == 0 || record.is_main,
            is_path_missing: false,
            last_modified_at: None,
        })
        .collect())
}

impl WorktreeOperations {
    async fn collect_worktrees(
        &self,
        project_path: &str,
        mut trace: Option<&mut Vec<GitCommandTrace>>,
    ) -> ExecutorResult<(String, Vec<WorktreeInfo>)> {
        let layout = match self.source {
            WorktreeSource::Auto => probe_worktree_layout(project_path, trace.as_deref_mut()).await,
            WorktreeSource::Git => None,
        };
        let mut records = None;
        let current_worktree_path = if let Some(layout) = layout {
            if layout.ref_format == "files" {
                match read_admin_worktree_records(&layout).await {
                    Ok(result) => records = result,
                    Err(_) => create_logger("git:worktrees")
                        .debug("Direct worktree metadata read failed; using Git."),
                }
            }
            layout.worktree_root
        } else {
            assert_git_repository(project_path, None).await?;
            let output = run_git_traced(
                project_path,
                args(["rev-parse", "--show-toplevel"]),
                trace.as_deref_mut(),
                readonly(),
            )
            .await?;
            trim(&output.stdout).to_owned()
        };
        let records = match records {
            Some(records) => records,
            None => read_porcelain_worktree_records(project_path, trace).await?,
        };
        let mut worktrees = Vec::new();
        for worktree in normalize_worktree_records(records, project_path)? {
            if let Some(check) = &self.assert_project_path_allowed
                && check
                    .assert_project_path_allowed(&worktree.path)
                    .await
                    .is_err()
            {
                continue;
            }
            worktrees.push(worktree);
        }
        let metadata =
            map_with_concurrency_result(&worktrees, WORKTREE_STAT_CONCURRENCY, |worktree, _| {
                let path = worktree.path.clone();
                async move { Ok::<_, Infallible>(enrich_worktree_metadata(&path).await) }
            })
            .await?;
        for (worktree, (missing, modified)) in worktrees.iter_mut().zip(metadata) {
            worktree.is_path_missing = missing;
            worktree.last_modified_at = modified;
        }
        Ok((current_worktree_path, worktrees))
    }

    pub async fn get_worktrees(
        &self,
        project_path: &str,
        trace: Option<&mut Vec<GitCommandTrace>>,
    ) -> ExecutorResult<GitWorktreesResult> {
        let (_, worktrees) = self.collect_worktrees(project_path, trace).await?;
        Ok(GitWorktreesResult { worktrees })
    }

    pub async fn get_target_candidates(
        &self,
        project_path: &str,
        trace: Option<&mut Vec<GitCommandTrace>>,
    ) -> ExecutorResult<GitTargetCandidatesResult> {
        let (current, worktrees) = self.collect_worktrees(project_path, trace).await?;
        let repo_root = if current.is_empty() {
            project_path.to_owned()
        } else {
            current
        };
        let resolved = native::resolve(&current_directory()?, &[&repo_root]);
        let cwd = current_directory()?;
        let current_worktree = worktrees
            .iter()
            .find(|worktree| worktree.is_current)
            .or_else(|| {
                worktrees
                    .iter()
                    .find(|worktree| native::resolve(&cwd, &[&worktree.path]) == resolved)
            });

        let mut targets = Vec::new();
        let mut seen = IndexSet::new();
        let mut add_target = |target: GitWorkbenchSnapshotTarget, is_current, is_missing| {
            if !target.worktree_path.is_empty() && seen.insert(target.worktree_path.clone()) {
                targets.push(TargetCandidate {
                    target,
                    is_current,
                    is_missing,
                });
            }
        };
        let project_name = native::basename(project_path);
        add_target(
            GitWorkbenchSnapshotTarget {
                project_path: project_path.into(),
                repo_root: repo_root.clone(),
                worktree_path: repo_root.clone(),
                label: if project_name.is_empty() {
                    project_path.into()
                } else {
                    project_name
                },
                branch: current_worktree
                    .map_or_else(String::new, |worktree| worktree.branch.clone()),
                source: GitWorkbenchSource::ChatProject,
            },
            true,
            false,
        );
        for worktree in worktrees {
            let mut label = if worktree.name.is_empty() {
                native::basename(&worktree.path)
            } else {
                worktree.name
            };
            if !worktree.branch.is_empty() {
                label.push_str(&format!(" ({})", worktree.branch));
            }
            add_target(
                GitWorkbenchSnapshotTarget {
                    project_path: worktree.path.clone(),
                    repo_root: repo_root.clone(),
                    worktree_path: worktree.path,
                    label,
                    branch: worktree.branch,
                    source: GitWorkbenchSource::Worktree,
                },
                worktree.is_current,
                worktree.is_path_missing,
            );
        }
        Ok(GitTargetCandidatesResult { targets })
    }
}

pub async fn get_repo_info(project_path: &str) -> RepoInfo {
    let root = if directory_accessible(project_path).await {
        run_git(
            project_path,
            args(["rev-parse", "--show-toplevel"]),
            readonly(),
        )
        .await
        .ok()
        .map(|result| trim(&result.stdout).to_owned())
    } else {
        None
    };
    RepoInfo {
        is_git_repository: root.is_some(),
        repo_root: root.clone(),
        current_worktree_path: root,
    }
}

async fn local_branch_exists(project_path: &str, name: &str) -> bool {
    run_git(
        project_path,
        args(["rev-parse", "--verify", &format!("refs/heads/{name}")]),
        readonly(),
    )
    .await
    .is_ok()
}

fn worktree_mutation(
    output: String,
    default: &str,
    worktree_path: Option<String>,
) -> GitMutationResult {
    GitMutationResult {
        success: true,
        output: Some(if output.is_empty() {
            default.into()
        } else {
            output
        }),
        output_truncated: None,
        message: None,
        remote_name: None,
        remote_branch: None,
        worktree_path,
    }
}

pub async fn create_worktree(options: &CreateWorktreeOptions) -> ExecutorResult<GitMutationResult> {
    let project_path = &options.project_path;
    assert_git_repository(project_path, None).await?;
    let base = options.base_ref.as_deref().filter(|base| !base.is_empty());
    if let Some(base) = base {
        assert_existing_commit_ref(project_path, base, "base", None).await?;
    }
    let name = options
        .new_branch
        .as_deref()
        .or(options.branch.as_deref())
        .filter(|name| !name.is_empty());
    if let Some(name) = name {
        assert_safe_branch_name(project_path, name, Some("branch name"), None).await?;
    }
    let cwd = current_directory()?;
    let resolved = native::resolve(&cwd, &[project_path, &options.worktree_path]);
    assert_fresh_worktree_destination(project_path, &resolved).await?;

    let mut argv = args(["worktree", "add"]);
    let mut checkout_ref = base;
    if options.detach == Some(true) {
        argv.push("--detach".into());
    } else if let Some(name) = name {
        if options.new_branch.as_deref().is_none_or(str::is_empty)
            && local_branch_exists(project_path, name).await
        {
            checkout_ref = Some(name);
        } else {
            argv.extend(args(["--no-track", "-b", name]));
        }
    }
    argv.push(options.worktree_path.clone());
    argv.extend(checkout_ref.map(str::to_owned));
    let output = run_git(project_path, argv, GitCommandOptions::default())
        .await?
        .stdout;
    Ok(worktree_mutation(
        output,
        "Worktree created",
        Some(resolved),
    ))
}

pub async fn remove_worktree(options: &RemoveWorktreeOptions) -> ExecutorResult<GitMutationResult> {
    assert_git_repository(&options.project_path, None).await?;
    let mut argv = args(["worktree", "remove"]);
    if options.force == Some(true) {
        argv.push("--force".into());
    }
    argv.push(options.worktree_path.clone());
    let output = run_git(&options.project_path, argv, GitCommandOptions::default())
        .await?
        .stdout;
    Ok(worktree_mutation(output, "Worktree removed", None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_null_for_the_uncaptured_invalid_date_that_cannot_be_iso8601() {
        assert_eq!(serialize_worktree_mtime(f64::NAN), None);
    }
}
