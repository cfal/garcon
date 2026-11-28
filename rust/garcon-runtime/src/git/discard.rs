//! Ports `server/runtime/git/discard.ts`.

use std::io::ErrorKind;

use garcon_base::path_boundary::resolve_real_within_base;
use garcon_contract::git::{FileOptions, GitMutationResult};
use garcon_interface::resources::ExecutorResult;
use tokio::fs;

use super::git_domain_error::GitDomainError;
use super::operation_context::{assert_git_working_path, mark_git_mutation_dispatched};
use super::pathspecs::literal_git_pathspec;
use super::porcelain_status::{UNMERGED_STATUSES, parse_porcelain_v1_z};
use super::run::{
    assert_git_repository, read_only_git_options, resolve_path_within_project, run_git,
};
use super::types::GitCommandOptions;

fn readonly() -> GitCommandOptions {
    read_only_git_options(GitCommandOptions::default())
}

async fn head_has_path(project_path: &str, file: &str) -> ExecutorResult<bool> {
    let output = run_git(
        project_path,
        vec![
            "ls-tree".into(),
            "-z".into(),
            "HEAD".into(),
            "--".into(),
            literal_git_pathspec(file),
        ],
        readonly(),
    )
    .await?;
    Ok(!output.stdout.is_empty())
}

async fn restore(repo_root: &str, file: &str) -> ExecutorResult<()> {
    run_git(
        repo_root,
        vec!["restore".into(), "--".into(), literal_git_pathspec(file)],
        GitCommandOptions::default(),
    )
    .await?;
    Ok(())
}

async fn reset(repo_root: &str, file: &str) -> ExecutorResult<()> {
    run_git(
        repo_root,
        vec![
            "reset".into(),
            "HEAD".into(),
            "--".into(),
            literal_git_pathspec(file),
        ],
        GitCommandOptions::default(),
    )
    .await?;
    Ok(())
}

pub async fn discard(request: &FileOptions) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    let file = &request.file;
    assert_git_repository(project, None).await?;
    let root = run_git(
        project,
        ["rev-parse", "--show-toplevel"].map(str::to_owned).into(),
        readonly(),
    );
    let prefix = run_git(
        project,
        ["rev-parse", "--show-prefix"].map(str::to_owned).into(),
        readonly(),
    );
    let (root, prefix) = tokio::try_join!(biased; root, prefix)?;
    let root = root.stdout.strip_suffix('\n').unwrap_or(&root.stdout);
    let repo_root = if root.is_empty() { project } else { root };
    let project_prefix = prefix.stdout.strip_suffix('\n').unwrap_or(&prefix.stdout);
    let canonical_file = format!("{project_prefix}{}", file.trim_end_matches('/'));

    let status = run_git(
        repo_root,
        ["status", "--porcelain=v1", "-z", "-uall"]
            .map(str::to_owned)
            .into(),
        readonly(),
    )
    .await?;
    let entries = parse_porcelain_v1_z(&status.stdout);
    let exact = entries
        .iter()
        .find(|entry| entry.path.trim_end_matches('/') == canonical_file);
    let rename_source = entries.iter().find(|entry| {
        entry.original_path.as_deref() == Some(&canonical_file) && entry.work_tree_status == 'R'
    });
    // A staged-only entry can shadow the source of an unstaged rename.
    let entry = exact
        .filter(|entry| entry.work_tree_status != ' ')
        .or(rename_source)
        .or(exact)
        .ok_or_else(|| {
            GitDomainError::new(
                "INVALID_INPUT",
                "No local working-tree changes were found for this file.",
            )
        })?;
    let status = format!("{}{}", entry.index_status, entry.work_tree_status);

    if status == "??" {
        let path = resolve_path_within_project(project, file)?;
        resolve_real_within_base(project, &path).await?;
        assert_git_working_path(&path).await?;
        let stats = fs::metadata(&path).await?;
        mark_git_mutation_dispatched();
        if stats.is_dir() {
            if let Err(error) = fs::remove_dir_all(&path).await
                && error.kind() != ErrorKind::NotFound
            {
                return Err(error.into());
            }
        } else {
            fs::remove_file(&path).await?;
        }
    } else if matches!(entry.work_tree_status, 'R' | 'C') {
        // Reset the intent-to-add destination without replacing its worktree content.
        if entry.work_tree_status == 'R'
            && let Some(original) = entry
                .original_path
                .as_deref()
                .filter(|path| !path.is_empty())
        {
            restore(repo_root, original).await?;
        }
        reset(repo_root, &entry.path).await?;
    } else if UNMERGED_STATUSES.contains(&status.as_str()) {
        reset(repo_root, &entry.path).await?;
        if head_has_path(repo_root, &entry.path).await? {
            restore(repo_root, &entry.path).await?;
        }
    } else if status == "A " || entry.work_tree_status == 'A' {
        reset(repo_root, &entry.path).await?;
    } else if matches!(entry.work_tree_status, 'M' | 'D' | 'T') {
        restore(repo_root, &entry.path).await?;
    }

    Ok(GitMutationResult {
        success: true,
        output: None,
        output_truncated: None,
        message: Some(format!("Changes discarded for {file}")),
        remote_name: None,
        remote_branch: None,
        worktree_path: None,
    })
}
