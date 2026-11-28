//! Ports `server/runtime/git/git-error-classifier.ts`.

use garcon_base::errors::{ErrorInput, error_message};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClassifiedGitError {
    pub code: &'static str,
    pub status: u16,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<&'static str>,
}

pub fn classify_git_error(error: ErrorInput<'_>) -> ClassifiedGitError {
    let message = error_message(error, Some("Git operation failed."));
    let text = message.to_lowercase();
    let (code, status, message, details) = if text.contains("not a git repository")
        || text.contains("git is not initialized")
    {
        ("NOT_REPO", 400, "Path is not a Git repository.", None)
    } else if text.contains("does not appear to be a git repository") {
        (
            "NO_REMOTE",
            500,
            "Remote repository is not configured.",
            Some("Verify the remote URL and access rights."),
        )
    } else if text.contains("permission denied") {
        (
            "AUTH_FAILED",
            401,
            "Git authentication failed.",
            Some("Verify credentials or SSH key access."),
        )
    } else if text.contains("host key verification failed") {
        (
            "HOST_KEY",
            502,
            "SSH host key verification failed.",
            Some(
                "The remote host is not in your known_hosts file. Run: ssh-keyscan <host> >> ~/.ssh/known_hosts",
            ),
        )
    } else if text.contains("could not resolve hostname") {
        (
            "NETWORK",
            502,
            "Could not reach the remote host.",
            Some("Verify network access and remote URL."),
        )
    } else if text.contains("please commit your changes or stash them") {
        (
            "UNCOMMITTED_CHANGES",
            409,
            "Uncommitted local changes block this operation.",
            Some("Commit or stash local changes before proceeding."),
        )
    } else if text.contains("diverged") {
        (
            "DIVERGED",
            409,
            "Local and remote branches have diverged.",
            Some("Fetch and review before proceeding."),
        )
    } else if text.contains("conflict") {
        (
            "CONFLICT",
            409,
            "Operation produced merge conflicts.",
            Some("Resolve conflicts, stage the fixes, then commit."),
        )
    } else if text.contains("nothing to commit") || text.contains("nothing added") {
        ("NOTHING_TO_COMMIT", 400, "No staged changes found.", None)
    } else if text.contains("rejected") || text.contains("non-fast-forward") {
        (
            "REJECTED",
            409,
            "Push was rejected by the remote.",
            Some("The remote has newer commits. Pull and reconcile first."),
        )
    } else if text.contains("no upstream branch") {
        (
            "NO_UPSTREAM",
            400,
            "No upstream branch is configured.",
            Some("Run: git push --set-upstream origin <branch>."),
        )
    } else if text.contains("index.lock")
        || text.contains("unable to create") && text.contains(".lock")
    {
        (
            "GIT_LOCKED",
            409,
            "Git index is locked by another process.",
            Some(
                "Another git operation may be running. Wait and retry, or remove the stale lock file.",
            ),
        )
    } else if text.contains("no such file or directory") && text.contains("ssh") {
        (
            "SSH_MISSING",
            502,
            "SSH client is not available.",
            Some("Ensure an SSH client is installed and accessible in PATH."),
        )
    } else {
        return ClassifiedGitError {
            code: "UNKNOWN",
            status: 500,
            message: message.into_owned(),
            details: None,
        };
    };
    ClassifiedGitError {
        code,
        status,
        message: message.into(),
        details,
    }
}
