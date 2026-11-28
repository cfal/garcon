//! Reads complete pull-request and review-policy connections from GitHub CLI.

use std::collections::HashSet;

use garcon_contract::gh::{
    GhActorIdentity, GhRepositoryIdentity, PullRequestListResult, PullRequestReviewTarget,
};
use garcon_contract::gh_identity::{gh_repository_identity, same_gh_repository};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_interface::resources::ExecutorResult;
use garcon_js::number_to_string;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::gh_mappers::{build_pull_request_list, build_review_target, text};
use super::gh_repository::{assert_gh_actor, repository_fields, require_gh_actor};
use super::gh_review_queries::{
    LABELS_QUERY, LIST_QUERY, REQUESTED_QUERY, REVIEW_REQUESTS_QUERY, REVIEW_TARGET_QUERY,
};
use super::gh_types::{GhCommandOptions, GhDomainError};
use super::run::run_gh_json;

struct ReadContext<'a> {
    project: &'a str,
    identity: &'a GhRepositoryIdentity,
    signal: Option<&'a CancellationToken>,
}

fn take(value: &mut Value, key: &str) -> Value {
    value
        .as_object_mut()
        .and_then(|object| object.shift_remove(key))
        .unwrap_or_default()
}

impl ReadContext<'_> {
    async fn graphql(
        &self,
        query: &str,
        fields: &[String],
        cursor: Option<&str>,
        viewer: Option<&GhActorIdentity>,
    ) -> ExecutorResult<Value> {
        let mut args = vec![
            "api".into(),
            "graphql".into(),
            "--hostname".into(),
            self.identity.host.clone(),
        ];
        args.extend_from_slice(fields);
        args.extend(["-f".into(), format!("query={query}")]);
        if let Some(cursor) = cursor {
            args.extend(["-f".into(), format!("endCursor={cursor}")]);
        }
        let raw = run_gh_json(
            self.project,
            args,
            GhCommandOptions::for_signal(self.signal),
        )
        .await?;
        let data = &raw["data"];
        let actor = require_gh_actor(&data["viewer"])?;
        if let Some(viewer) = viewer {
            assert_gh_actor(&actor, viewer)?;
        }
        let repo = &data["repository"];
        if !repo.is_null()
            && !gh_repository_identity(text(repo, "nameWithOwner"), text(repo, "url"))
                .is_some_and(|actual| same_gh_repository(&actual, self.identity))
        {
            return Err(GitServiceError::new(
                Code::GIT_CONFLICT,
                "The GitHub repository identity changed during the read.",
            )
            .into());
        }
        Ok(raw)
    }
}

async fn complete_connection(
    mut page: Value,
    mut next: impl AsyncFnMut(&str) -> ExecutorResult<Value>,
) -> ExecutorResult<Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let Some(has_next) = page["pageInfo"]["hasNextPage"].as_bool() else {
            return Err("GitHub returned an incomplete connection.".into());
        };
        let Value::Array(nodes) = take(&mut page, "nodes") else {
            return Err("GitHub returned an incomplete connection.".into());
        };
        if page["issueCount"]
            .as_f64()
            .is_some_and(|count| count > 1_000.0)
        {
            return Err("GitHub review-request search exceeds its 1,000-result limit.".into());
        }
        result.extend(nodes.into_iter().filter(|node| !node.is_null()));
        if !has_next {
            return Ok(json!({ "nodes": result }));
        }
        let Some(cursor) = page["pageInfo"]["endCursor"]
            .as_str()
            .filter(|cursor| !cursor.is_empty())
        else {
            return Err("GitHub returned an invalid pagination cursor.".into());
        };
        if !seen.insert(cursor.to_owned()) {
            return Err("GitHub returned an invalid pagination cursor.".into());
        }
        page = next(cursor).await?;
    }
}

pub async fn read_pull_request_list(
    project: &str,
    identity: &GhRepositoryIdentity,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<PullRequestListResult> {
    let context = ReadContext {
        project,
        identity,
        signal,
    };
    let fields = repository_fields(identity);
    let mut raw = context.graphql(LIST_QUERY, &fields, None, None).await?;
    let viewer = require_gh_actor(&raw["data"]["viewer"])?;
    let repository = &mut raw["data"]["repository"];
    if repository.is_null() {
        return Err("GitHub returned no repository for this project.".into());
    }
    let mut pulls = complete_connection(take(repository, "pullRequests"), async |cursor| {
        let reply = context
            .graphql(LIST_QUERY, &fields, Some(cursor), Some(&viewer))
            .await?;
        Ok(reply["data"]["repository"]["pullRequests"].clone())
    })
    .await?;
    if let Some(nodes) = pulls["nodes"].as_array_mut() {
        for pull in nodes {
            let mut fields = repository_fields(identity);
            let number = pull["number"]
                .as_f64()
                .map(number_to_string)
                .unwrap_or_else(|| "undefined".into());
            fields.extend(["-F".into(), format!("number={number}")]);
            for (key, query) in [
                ("labels", LABELS_QUERY),
                ("reviewRequests", REVIEW_REQUESTS_QUERY),
            ] {
                pull[key] = complete_connection(take(pull, key), async |cursor| {
                    let reply = context
                        .graphql(query, &fields, Some(cursor), Some(&viewer))
                        .await?;
                    Ok(reply["data"]["repository"]["pullRequest"][key].clone())
                })
                .await?;
            }
        }
    }
    repository["pullRequests"] = pulls;
    let requested_fields = vec![
        "-f".into(),
        format!(
            "requested=repo:{} is:pr is:open review-requested:@me",
            identity.name_with_owner
        ),
    ];
    let requested = context
        .graphql(REQUESTED_QUERY, &requested_fields, None, Some(&viewer))
        .await?;
    raw["data"]["requested"] =
        complete_connection(requested["data"]["requested"].clone(), async |cursor| {
            let reply = context
                .graphql(
                    REQUESTED_QUERY,
                    &requested_fields,
                    Some(cursor),
                    Some(&viewer),
                )
                .await?;
            Ok(reply["data"]["requested"].clone())
        })
        .await?;
    build_pull_request_list(&raw)
}

fn pull_not_found() -> GhDomainError {
    GhDomainError::new("NOT_FOUND", "Pull request not found.")
}

pub async fn read_review_target(
    project: &str,
    identity: &GhRepositoryIdentity,
    number: u64,
    marker: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<PullRequestReviewTarget> {
    let context = ReadContext {
        project,
        identity,
        signal,
    };
    let mut fields = repository_fields(identity);
    fields.extend(["-F".into(), format!("number={number}")]);
    let mut raw = context
        .graphql(REVIEW_TARGET_QUERY, &fields, None, None)
        .await?;
    let viewer = require_gh_actor(&raw["data"]["viewer"])?;
    let pull = &mut raw["data"]["repository"]["pullRequest"];
    if pull.is_null() {
        return Err(pull_not_found().into());
    }
    let comments = complete_connection(take(pull, "comments"), async |cursor| {
        let page = context
            .graphql(REVIEW_TARGET_QUERY, &fields, Some(cursor), Some(&viewer))
            .await?;
        let current = &page["data"]["repository"]["pullRequest"];
        if current.is_null() {
            return Err(pull_not_found().into());
        }
        pull["state"] = current["state"].clone();
        pull["headRefOid"] = current["headRefOid"].clone();
        Ok(current["comments"].clone())
    })
    .await?;
    pull["comments"] = comments;
    Ok(build_review_target(&raw, marker).ok_or_else(pull_not_found)?)
}
