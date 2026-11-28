//! Validates checkout and authenticated actor identities reported by gh.

use garcon_contract::gh::{GhActorIdentity, GhRepositoryIdentity};
use garcon_contract::gh_identity::{gh_repository_identity, same_gh_repository};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_interface::resources::ExecutorResult;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::gh_mappers::{actor, text};
use super::gh_types::GhCommandOptions;
use super::run::run_gh_json;

pub async fn resolve_checkout_repository(
    project: &str,
    expected: Option<&GhRepositoryIdentity>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GhRepositoryIdentity> {
    let raw = run_gh_json(
        project,
        ["repo", "view", "--json", "nameWithOwner,url"]
            .map(str::to_owned)
            .into(),
        GhCommandOptions::for_signal(signal),
    )
    .await?;
    let identity = gh_repository_identity(text(&raw, "nameWithOwner"), text(&raw, "url"))
        .ok_or_else(|| {
            GitServiceError::new(
                Code::GIT_INVALID_RESULT,
                "GitHub returned an invalid repository identity.",
            )
        })?;
    if expected.is_some_and(|expected| !same_gh_repository(&identity, expected)) {
        return Err(GitServiceError::new(
            Code::GIT_CONFLICT, "The checkout repository has changed. Reconnect the intended repository before continuing.",
        ).into());
    }
    Ok(identity)
}

pub fn repository_fields(repository: &GhRepositoryIdentity) -> Vec<String> {
    let mut parts = repository.name_with_owner.split('/');
    let owner = parts.next().unwrap_or("undefined");
    let name = parts.next().unwrap_or("undefined");
    vec![
        "-f".into(),
        format!("owner={owner}"),
        "-f".into(),
        format!("name={name}"),
    ]
}

pub fn require_gh_actor(raw: &Value) -> Result<GhActorIdentity, GitServiceError> {
    actor(raw).ok_or_else(|| {
        GitServiceError::new(
            Code::GIT_INVALID_RESULT,
            "GitHub returned an invalid account identity.",
        )
    })
}

pub fn assert_gh_actor(
    actual: &GhActorIdentity,
    expected: &GhActorIdentity,
) -> Result<(), GitServiceError> {
    if actual.id != expected.id {
        return Err(GitServiceError::new(
            Code::GIT_CONFLICT,
            format!(
                "The GitHub account has changed. Switch back to {} before continuing.",
                expected.login
            ),
        ));
    }
    Ok(())
}

pub async fn read_posting_actor(
    project: &str,
    repository: &GhRepositoryIdentity,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GhActorIdentity> {
    let raw = run_gh_json(
        project,
        vec![
            "api".into(),
            "graphql".into(),
            "--hostname".into(),
            repository.host.clone(),
            "-f".into(),
            "query=query{viewer{id login}}".into(),
        ],
        GhCommandOptions::for_signal(signal),
    )
    .await?;
    Ok(require_gh_actor(&raw["data"]["viewer"])?)
}
