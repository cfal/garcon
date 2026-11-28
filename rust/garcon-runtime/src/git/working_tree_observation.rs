//! Ports `server/runtime/git/working-tree-observation.ts`.

use std::cell::RefCell;
use std::convert::Infallible;

use garcon_base::concurrency::map_with_concurrency_result;
use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::git::{
    GIT_WORKING_TREE_FINGERPRINT_VERSION, GitWorkingTreeFingerprintResponse,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, trim, utf16};
use indexmap::{IndexMap, IndexSet};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::files::file_revision::stat_path;

use super::operation_context::assert_git_working_path;
use super::pathspecs::chunk_git_pathspecs;
use super::porcelain_status::{PorcelainStatusEntry, has_work_tree_change, parse_porcelain_v1_z};
use super::run::{
    directory_accessible, read_only_git_options, resolve_path_within_project, run_git,
    run_git_traced_shared,
};
use super::types::{GitCommandOptions, GitCommandResult, GitCommandTrace};

const VERSION: u8 = GIT_WORKING_TREE_FINGERPRINT_VERSION;

pub fn parse_ls_files_stage_z(output: &str) -> IndexMap<String, String> {
    output
        .split('\0')
        .filter_map(|token| token.split_once('\t').map(|(_, path)| (path, token)))
        .filter(|(path, _)| !path.is_empty())
        .map(|(path, token)| (path.to_owned(), token.to_owned()))
        .collect()
}

fn unique_git_paths<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut paths: Vec<_> = paths
        .into_iter()
        .filter(|path| !path.is_empty())
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(str::to_owned)
        .collect();
    paths.sort_by(|left, right| utf16::cmp(left, right));
    paths
}

fn readonly(signal: Option<&CancellationToken>) -> GitCommandOptions {
    read_only_git_options(GitCommandOptions {
        signal: signal.cloned(),
        ..Default::default()
    })
}

async fn load_fingerprint_index_entry_map(
    project_path: &str,
    paths: &[String],
    signal: Option<&CancellationToken>,
) -> ExecutorResult<IndexMap<String, String>> {
    let mut entries = IndexMap::new();
    for chunk in chunk_git_pathspecs(paths) {
        let args = ["ls-files", "-s", "-z", "--"]
            .map(str::to_owned)
            .into_iter()
            .chain(chunk.iter().cloned())
            .collect();
        match run_git(project_path, args, readonly(signal)).await {
            Ok(output) => entries.extend(parse_ls_files_stage_z(&output.stdout)),
            Err(error) if signal.is_some_and(CancellationToken::is_cancelled) => return Err(error),
            Err(_) => {}
        }
    }
    Ok(entries)
}

fn node_truncated_millis(ns: i128) -> f64 {
    let seconds = ns.div_euclid(1_000_000_000) as f64;
    let nano_remainder = ns.rem_euclid(1_000_000_000) as f64;
    (seconds * 1000.0 + nano_remainder / 1_000_000.0).trunc()
}

async fn worktree_stat_fingerprint(project_path: &str, file: &str) -> String {
    let result = async {
        let resolved = resolve_path_within_project(project_path, file)?;
        assert_git_working_path(&resolved).await?;
        Ok::<_, Box<dyn std::error::Error>>(stat_path(&resolved).await?)
    }
    .await;
    match result {
        Ok(stat) => {
            let kind = if stat.is_file { "file" } else { "not-file" };
            let stat = stat.revision;
            let mtime = garcon_js::number_to_string(node_truncated_millis(stat.mtime_ns));
            let ctime = garcon_js::number_to_string(node_truncated_millis(stat.ctime_ns));
            let size = garcon_js::number_to_string(stat.size as f64);
            format!("{kind}:{file}:{size}:{mtime}:{ctime}")
        }
        Err(_) => format!("missing:{file}"),
    }
}

fn should_stat_worktree_for_fingerprint(entry: &PorcelainStatusEntry) -> bool {
    if entry.work_tree_status == 'D' {
        return false;
    }
    entry.index_status == '?'
        || entry.work_tree_status == '?'
        || has_work_tree_change(entry.work_tree_status.encode_utf8(&mut [0; 4]))
}

async fn load_fingerprint_worktree_stats(
    project_path: &str,
    entries: &[PorcelainStatusEntry],
) -> ExecutorResult<Vec<String>> {
    let paths = unique_git_paths(
        entries
            .iter()
            .filter(|entry| should_stat_worktree_for_fingerprint(entry))
            .map(|entry| entry.path.as_str()),
    );
    let mut stats = map_with_concurrency_result(&paths, 16.0, |path, _| {
        let path = path.clone();
        async move { Ok::<_, Infallible>(worktree_stat_fingerprint(project_path, &path).await) }
    })
    .await?;
    stats.sort_by(|left, right| utf16::cmp(left, right));
    Ok(stats)
}

fn index_tokens(entries: &IndexMap<String, String>) -> Vec<String> {
    let mut tokens: Vec<_> = entries
        .iter()
        .map(|(file, entry)| format!("{file}\0{entry}"))
        .collect();
    tokens.sort_by(|left, right| utf16::cmp(left, right));
    tokens
}

pub fn not_repository_fingerprint(project_path: &str) -> GitWorkingTreeFingerprintResponse {
    GitWorkingTreeFingerprintResponse::NotGitRepository {
        project: project_path.into(),
        fingerprint_version: VERSION,
        fingerprint: (),
        message: "Git is not initialized in this directory.".into(),
    }
}

#[derive(Debug)]
pub struct GitWorkingTreeObservation {
    pub project_path: String,
    pub repo_root: String,
    pub branch: String,
    pub head: String,
    pub status_output: String,
    pub working_stats_output: String,
    pub cached_stats_output: String,
    pub unmerged_output: String,
    pub status_entries: Vec<PorcelainStatusEntry>,
    pub changed_paths: Vec<String>,
    pub index_entries_by_path: IndexMap<String, String>,
    pub worktree_stat_tokens: Vec<String>,
    pub fingerprint: String,
    pub changed_path_count: usize,
}

#[derive(Debug, thiserror::Error)]
#[error("Git working-tree observation requires a repository.")]
pub struct GitWorkingTreeNotRepositoryError {
    #[source]
    cause: Box<dyn std::error::Error>,
}

impl DiagnosticError for GitWorkingTreeNotRepositoryError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "GitWorkingTreeNotRepositoryError",
            code: None,
        }
    }
}

fn build_workbench_fingerprint_from_inputs(observation: &GitWorkingTreeObservation) -> String {
    let version_label = format!("git-working-tree-fingerprint-v{VERSION}");
    let index_tokens = index_tokens(&observation.index_entries_by_path);
    let input = [
        &version_label,
        &observation.project_path,
        &observation.repo_root,
        &observation.branch,
        &observation.head,
        &observation.status_output,
        &observation.working_stats_output,
        &observation.cached_stats_output,
        &observation.unmerged_output,
    ]
    .into_iter()
    .chain(&index_tokens)
    .chain(&observation.worktree_stat_tokens);
    let mut digest = Sha256::new();
    for (index, part) in input.enumerate() {
        if index != 0 {
            digest.update(b"\x1f");
        }
        digest.update(part.as_bytes());
    }
    let hash = digest.finalize();
    format!(
        "v{VERSION}:{:016x}",
        u64::from_be_bytes([
            hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7],
        ])
    )
}

fn trimmed_or_empty(result: ExecutorResult<GitCommandResult>) -> String {
    result.map_or_else(|_| String::new(), |result| trim(&result.stdout).to_owned())
}

fn stdout_or_empty(result: ExecutorResult<GitCommandResult>) -> String {
    result.map_or_else(|_| String::new(), |result| result.stdout)
}

pub async fn capture_working_tree_observation(
    project_path: &str,
    known_repo_root: Option<&str>,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitWorkingTreeObservation> {
    let run = |args: &[&str]| {
        run_git_traced_shared(
            project_path,
            args.iter().map(|arg| (*arg).to_owned()).collect(),
            trace,
            readonly(signal),
        )
    };
    let find_repo_root = async {
        if let Some(root) = known_repo_root.filter(|root| !root.is_empty()) {
            Ok(GitCommandResult {
                stdout: root.into(),
                stderr: String::new(),
            })
        } else {
            run(&["rev-parse", "--show-toplevel"]).await
        }
    };
    let (repo_root, branch, head, status, working, cached, unmerged) = tokio::join!(biased;
        find_repo_root,
        run(&["branch", "--show-current"]),
        run(&["rev-parse", "HEAD"]),
        run(&["status", "--porcelain=v1", "-z", "-uall"]),
        run(&["diff", "--numstat", "-z"]),
        run(&["diff", "--cached", "--numstat", "-z"]),
        run(&["ls-files", "-u", "-z"]),
    );
    let repo_root = match repo_root {
        Ok(output) => {
            let root = trim(&output.stdout);
            if root.is_empty() {
                project_path.into()
            } else {
                root.to_owned()
            }
        }
        Err(error) if signal.is_some_and(CancellationToken::is_cancelled) => return Err(error),
        Err(cause) => return Err(GitWorkingTreeNotRepositoryError { cause }.into()),
    };
    let status_output = status?.stdout;
    let status_entries = parse_porcelain_v1_z(&status_output);
    let changed_paths = unique_git_paths(status_entries.iter().map(|entry| entry.path.as_str()));
    let (index_entries_by_path, worktree_stat_tokens) = tokio::try_join!(biased;
        load_fingerprint_index_entry_map(project_path, &changed_paths, signal),
        load_fingerprint_worktree_stats(project_path, &status_entries),
    )?;
    let mut observation = GitWorkingTreeObservation {
        project_path: project_path.into(),
        repo_root,
        branch: trimmed_or_empty(branch),
        head: trimmed_or_empty(head),
        status_output,
        working_stats_output: stdout_or_empty(working),
        cached_stats_output: stdout_or_empty(cached),
        unmerged_output: stdout_or_empty(unmerged),
        status_entries,
        changed_path_count: changed_paths.len(),
        changed_paths,
        index_entries_by_path,
        worktree_stat_tokens,
        fingerprint: String::new(),
    };
    observation.fingerprint = build_workbench_fingerprint_from_inputs(&observation);
    Ok(observation)
}

pub async fn is_working_tree_observation_current(
    observation: &GitWorkingTreeObservation,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<bool> {
    let path = &observation.project_path;
    let run = |args: &[&str]| {
        run_git_traced_shared(
            path,
            args.iter().map(|arg| (*arg).to_owned()).collect(),
            trace,
            readonly(signal),
        )
    };
    let (branch, head, status, unmerged) = tokio::join!(biased;
        run(&["branch", "--show-current"]),
        run(&["rev-parse", "HEAD"]),
        run(&["status", "--porcelain=v1", "-z", "-uall"]),
        run(&["ls-files", "-u", "-z"]),
    );
    let status = status?.stdout;
    if trimmed_or_empty(branch) != observation.branch
        || trimmed_or_empty(head) != observation.head
        || status != observation.status_output
        || stdout_or_empty(unmerged) != observation.unmerged_output
    {
        return Ok(false);
    }
    let current_entries =
        load_fingerprint_index_entry_map(path, &observation.changed_paths, signal).await?;
    if index_tokens(&current_entries).join("\x1f")
        != index_tokens(&observation.index_entries_by_path).join("\x1f")
    {
        return Ok(false);
    }
    let stats = load_fingerprint_worktree_stats(path, &observation.status_entries).await?;
    Ok(stats.join("\x1f") == observation.worktree_stat_tokens.join("\x1f"))
}

pub async fn get_working_tree_fingerprint(
    project_path: &str,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitWorkingTreeFingerprintResponse> {
    if !directory_accessible(project_path).await {
        return Ok(not_repository_fingerprint(project_path));
    }
    let observation =
        match capture_working_tree_observation(project_path, None, trace, signal).await {
            Ok(observation) => observation,
            Err(error) if error.is::<GitWorkingTreeNotRepositoryError>() => {
                return Ok(not_repository_fingerprint(project_path));
            }
            Err(error) => return Err(error),
        };
    Ok(GitWorkingTreeFingerprintResponse::Ready {
        project: project_path.into(),
        fingerprint_version: VERSION,
        fingerprint: observation.fingerprint,
        changed_path_count: Number(observation.changed_path_count as f64),
    })
}
