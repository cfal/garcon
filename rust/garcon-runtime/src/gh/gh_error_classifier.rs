//! Ports `server/runtime/gh/gh-error-classifier.ts`.

use garcon_base::errors::{ErrorInput, error_message};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ClassifiedGhError {
    pub code: &'static str,
    pub status: u16,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<&'static str>,
}

pub fn classify_gh_error(error: ErrorInput<'_>) -> ClassifiedGhError {
    let message = error_message(error, Some("GitHub CLI operation failed."));
    let text = message.to_lowercase();
    let includes = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    let (code, status, message, details) =
        if includes(&["gh) is not installed", "command not found"]) {
            (
                "GH_MISSING",
                500,
                "GitHub CLI (gh) is not installed.",
                Some("Install gh and run \"gh auth login\" to view pull requests."),
            )
        } else if includes(&[
            "gh auth login",
            "not logged",
            "authentication",
            "requires authentication",
            "bad credentials",
        ]) {
            (
                "AUTH_FAILED",
                401,
                "GitHub CLI is not authenticated.",
                Some("Run: gh auth login"),
            )
        } else if includes(&[
            "none of the git remotes",
            "no git remotes",
            "not a github repository",
        ]) {
            (
                "NO_GITHUB_REMOTE",
                400,
                "This repository has no GitHub remote.",
                Some("Add a GitHub remote to view pull requests."),
            )
        } else if includes(&["not a git repository", "git is not initialized"]) {
            ("NOT_REPO", 400, "Path is not a Git repository.", None)
        } else if includes(&[
            "could not resolve to a pullrequest",
            "no pull requests found",
            "not found",
        ]) {
            ("NOT_FOUND", 404, "Pull request not found.", None)
        } else if includes(&["api rate limit", "rate limit exceeded"]) {
            (
                "RATE_LIMITED",
                429,
                "GitHub API rate limit exceeded.",
                Some("Wait a few minutes and try again."),
            )
        } else if includes(&[
            "http 403",
            "resource not accessible",
            "does not have the correct permissions",
        ]) {
            (
                "FORBIDDEN",
                403,
                "GitHub refused this operation for the signed-in account.",
                Some("Check that the gh login can read and comment on this repository."),
            )
        } else if includes(&[
            "could not resolve host",
            "network is unreachable",
            "timed out",
        ]) {
            (
                "NETWORK",
                502,
                "Could not reach GitHub.",
                Some("Verify network access and try again."),
            )
        } else {
            ("UNKNOWN", 500, message.as_ref(), None)
        };
    ClassifiedGhError {
        code,
        status,
        message: message.into(),
        details,
    }
}
