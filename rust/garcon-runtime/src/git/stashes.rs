//! Ports `server/runtime/git/stashes.ts`.

use garcon_contract::git::{
    GitMutationResult, GitStashEntry, GitStashesResult, StashCreateOptions, StashRefOptions,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, trim};
use tokio_util::sync::CancellationToken;

use super::git_domain_error::GitDomainError;
use super::log_records::nul_records;
use super::run::{assert_git_repository, read_only_git_options, run_git};
use super::types::GitCommandOptions;

fn stash_index(reference: &str) -> Option<&str> {
    let index = reference.strip_prefix("stash@{")?.strip_suffix('}')?;
    (!index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())).then_some(index)
}

fn assert_safe_stash_ref(reference: &str) -> Result<(), GitDomainError> {
    if stash_index(reference).is_none() {
        return Err(GitDomainError::new("INVALID_INPUT", "Invalid stash ref."));
    }
    Ok(())
}

fn invalid_stash_list() -> GitDomainError {
    GitDomainError::new("INVALID_RESULT", "Git returned an unreadable stash list.")
}

fn parse_stashes(output: &str) -> Result<Vec<GitStashEntry>, GitDomainError> {
    nul_records(output, 4, "stash list")?
        .into_iter()
        .map(|fields| {
            let (reference, hash, date, message) = (fields[0], fields[1], fields[2], fields[3]);
            let index = stash_index(reference).ok_or_else(invalid_stash_list)?;
            if !(40..=64).contains(&hash.len())
                || !hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            {
                return Err(invalid_stash_list());
            }
            Ok(GitStashEntry {
                index: Number(index.parse().map_err(|_| invalid_stash_list())?),
                reference: reference.into(),
                hash: hash.into(),
                date: date.into(),
                message: message.into(),
            })
        })
        .collect()
}

fn options(signal: Option<CancellationToken>) -> GitCommandOptions {
    GitCommandOptions {
        signal,
        ..Default::default()
    }
}

async fn list_stashes(
    project_path: &str,
    signal: Option<CancellationToken>,
) -> ExecutorResult<Vec<GitStashEntry>> {
    let output = run_git(
        project_path,
        ["stash", "list", "-z", "--format=%gd%x00%H%x00%ci%x00%s"]
            .map(str::to_owned)
            .into(),
        read_only_git_options(options(signal)),
    )
    .await?;
    Ok(parse_stashes(&output.stdout)?)
}

pub async fn get_stashes(
    project_path: &str,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitStashesResult> {
    assert_git_repository(project_path, None).await?;
    Ok(GitStashesResult {
        stashes: list_stashes(project_path, signal).await?,
    })
}

async fn listed_stash_selector(
    request: &StashRefOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<String> {
    assert_safe_stash_ref(&request.stash_ref)?;
    assert_git_repository(&request.project_path, None).await?;
    let entries = list_stashes(&request.project_path, signal).await?;
    let current = entries
        .iter()
        .find(|stash| stash.reference == request.stash_ref);
    if current.is_none_or(|stash| stash.hash != request.expected_hash) {
        return Err(GitDomainError::new(
            "STALE_STASH",
            "The stash list changed since it was loaded. Select the stash again from the current list.",
        ).into());
    }
    Ok(format!("refs/{}", request.stash_ref))
}

fn success(output: Option<String>) -> GitMutationResult {
    GitMutationResult {
        success: true,
        output,
        output_truncated: None,
        message: None,
        remote_name: None,
        remote_branch: None,
        worktree_path: None,
    }
}

pub async fn create_stash(
    request: &StashCreateOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    assert_git_repository(&request.project_path, None).await?;
    let mut args = vec!["stash".into(), "push".into()];
    if request.include_untracked == Some(true) {
        args.push("-u".into());
    }
    if let Some(message) = request
        .message
        .as_deref()
        .map(trim)
        .filter(|message| !message.is_empty())
    {
        args.extend(["-m".into(), message.into()]);
    }
    let output = run_git(&request.project_path, args, options(signal)).await?;
    Ok(success(Some(trim(&output.stdout).into())))
}

pub async fn apply_stash(
    request: &StashRefOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    listed_stash_selector(request, signal.clone()).await?;
    run_git(
        &request.project_path,
        vec![
            "stash".into(),
            "apply".into(),
            request.expected_hash.clone(),
        ],
        options(signal),
    )
    .await?;
    Ok(success(None))
}

pub async fn pop_stash(
    request: &StashRefOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    let selector = listed_stash_selector(request, signal.clone()).await?;
    run_git(
        &request.project_path,
        vec!["stash".into(), "pop".into(), selector],
        options(signal),
    )
    .await?;
    Ok(success(None))
}

pub async fn drop_stash(
    request: &StashRefOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    let selector = listed_stash_selector(request, signal.clone()).await?;
    run_git(
        &request.project_path,
        vec!["stash".into(), "drop".into(), selector],
        options(signal),
    )
    .await?;
    Ok(success(None))
}
