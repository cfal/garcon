//! Ports `server/runtime/git/ref-validation.ts`.

use garcon_js::trim;
use tokio_util::sync::CancellationToken;

use super::git_domain_error::GitDomainError;
use super::run::{read_only_git_options, run_git};
use super::types::GitCommandOptions;

fn invalid_ref(label: &str) -> GitDomainError {
    GitDomainError::new("INVALID_INPUT", format!("Invalid {label} ref."))
}

fn invalid_label(label: &str) -> GitDomainError {
    GitDomainError::new("INVALID_INPUT", format!("Invalid {label}."))
}

fn invalid_start_or_dot(value: &str) -> bool {
    value.is_empty() || value == "." || value.starts_with('-') || value.contains("..")
}

pub fn assert_safe_ref(reference: &str, label: &str) -> Result<(), GitDomainError> {
    if invalid_start_or_dot(reference)
        || !reference
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/@{}~^+-".contains(&b))
    {
        return Err(invalid_ref(label));
    }
    Ok(())
}

pub fn assert_safe_remote_name(remote: &str, label: Option<&str>) -> Result<(), GitDomainError> {
    if invalid_start_or_dot(remote)
        || !remote
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid_label(label.unwrap_or("remote")));
    }
    Ok(())
}

pub async fn assert_existing_commit_ref(
    project_path: &str,
    reference: &str,
    label: &str,
    signal: Option<CancellationToken>,
) -> Result<(), GitDomainError> {
    assert_safe_ref(reference, label)?;
    run_git(
        project_path,
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            format!("{reference}^{{commit}}"),
        ],
        read_only_git_options(GitCommandOptions {
            signal,
            ..Default::default()
        }),
    )
    .await
    .map(|_| ())
    .map_err(|_| invalid_ref(label))
}

pub async fn assert_safe_branch_name(
    project_path: &str,
    branch: &str,
    label: Option<&str>,
    signal: Option<CancellationToken>,
) -> Result<(), GitDomainError> {
    let label = label.unwrap_or("branch name");
    if invalid_start_or_dot(branch)
        || branch.contains(':')
        || branch
            .chars()
            .any(|ch| ch.is_ascii_control() || trim(ch.encode_utf8(&mut [0; 4])).is_empty())
    {
        return Err(invalid_label(label));
    }
    run_git(
        project_path,
        vec!["check-ref-format".into(), "--branch".into(), branch.into()],
        read_only_git_options(GitCommandOptions {
            signal,
            ..Default::default()
        }),
    )
    .await
    .map(|_| ())
    .map_err(|_| invalid_label(label))
}
