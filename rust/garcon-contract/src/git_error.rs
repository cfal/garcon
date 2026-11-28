//! Ports `common/git-error.ts`.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// One of the error codes the Git and GitHub services report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GitServiceErrorCode(&'static str);

impl GitServiceErrorCode {
    pub const GIT_INVALID_INPUT: Self = Self("GIT_INVALID_INPUT");
    pub const GIT_REQUEST_TOO_LARGE: Self = Self("GIT_REQUEST_TOO_LARGE");
    pub const GIT_NOT_REPO: Self = Self("GIT_NOT_REPO");
    pub const GIT_OUTSIDE_BASE: Self = Self("GIT_OUTSIDE_BASE");
    pub const GIT_AUTH_FAILED: Self = Self("GIT_AUTH_FAILED");
    pub const GIT_HOST_KEY: Self = Self("GIT_HOST_KEY");
    pub const GIT_NETWORK: Self = Self("GIT_NETWORK");
    pub const GIT_UNCOMMITTED_CHANGES: Self = Self("GIT_UNCOMMITTED_CHANGES");
    pub const GIT_DIVERGED: Self = Self("GIT_DIVERGED");
    pub const GIT_CONFLICT: Self = Self("GIT_CONFLICT");
    pub const GIT_NOTHING_TO_COMMIT: Self = Self("GIT_NOTHING_TO_COMMIT");
    pub const GIT_REJECTED: Self = Self("GIT_REJECTED");
    pub const GIT_NO_UPSTREAM: Self = Self("GIT_NO_UPSTREAM");
    pub const GIT_LOCKED: Self = Self("GIT_LOCKED");
    pub const GIT_SSH_MISSING: Self = Self("GIT_SSH_MISSING");
    pub const GIT_NO_REMOTE: Self = Self("GIT_NO_REMOTE");
    pub const GIT_STALE_DOCUMENT: Self = Self("GIT_STALE_DOCUMENT");
    pub const GIT_STALE_STASH: Self = Self("GIT_STALE_STASH");
    pub const GIT_SERVICE_BUSY: Self = Self("GIT_SERVICE_BUSY");
    pub const GIT_RESULT_TOO_LARGE: Self = Self("GIT_RESULT_TOO_LARGE");
    pub const GIT_INVALID_RESULT: Self = Self("GIT_INVALID_RESULT");
    pub const GIT_UNAVAILABLE: Self = Self("GIT_UNAVAILABLE");
    pub const GIT_TIMEOUT: Self = Self("GIT_TIMEOUT");
    pub const GIT_MUTATION_OUTCOME_UNKNOWN: Self = Self("GIT_MUTATION_OUTCOME_UNKNOWN");
    pub const GIT_OPERATION_FAILED: Self = Self("GIT_OPERATION_FAILED");
    pub const GIT_MISSING: Self = Self("GIT_MISSING");
    pub const GH_MISSING: Self = Self("GH_MISSING");
    pub const GH_AUTH_FAILED: Self = Self("GH_AUTH_FAILED");
    pub const GH_NO_GITHUB_REMOTE: Self = Self("GH_NO_GITHUB_REMOTE");
    pub const GH_NOT_REPO: Self = Self("GH_NOT_REPO");
    pub const GH_NOT_FOUND: Self = Self("GH_NOT_FOUND");
    pub const GH_FORBIDDEN: Self = Self("GH_FORBIDDEN");
    pub const GH_NETWORK: Self = Self("GH_NETWORK");
    pub const GH_RATE_LIMITED: Self = Self("GH_RATE_LIMITED");
    pub const GH_OPERATION_FAILED: Self = Self("GH_OPERATION_FAILED");
    pub const GH_STALE_PULL_REQUEST: Self = Self("GH_STALE_PULL_REQUEST");
    pub const GH_MUTATION_REJECTED: Self = Self("GH_MUTATION_REJECTED");

    pub fn as_str(self) -> &'static str {
        self.0
    }

    /// The HTTP status an error of this code answers with.
    pub fn status(self) -> u16 {
        // INFALLIBLE: every code is a row of `GIT_ERROR_STATUS`.
        let (_, status) = GIT_ERROR_STATUS
            .iter()
            .find(|(code, _)| *code == self)
            .expect("every code is a row of `GIT_ERROR_STATUS`");
        *status
    }
}

impl fmt::Display for GitServiceErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Serialize for GitServiceErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for GitServiceErrorCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        is_git_service_error_code(&value).ok_or_else(|| {
            serde::de::Error::custom(format_args!("unknown Git service error code: {value}"))
        })
    }
}

/// The HTTP status of every Git and GitHub service error code.
pub const GIT_ERROR_STATUS: &[(GitServiceErrorCode, u16)] = &[
    (GitServiceErrorCode::GIT_INVALID_INPUT, 400),
    (GitServiceErrorCode::GIT_REQUEST_TOO_LARGE, 413),
    (GitServiceErrorCode::GIT_NOT_REPO, 400),
    (GitServiceErrorCode::GIT_OUTSIDE_BASE, 403),
    (GitServiceErrorCode::GIT_AUTH_FAILED, 401),
    (GitServiceErrorCode::GIT_HOST_KEY, 502),
    (GitServiceErrorCode::GIT_NETWORK, 502),
    (GitServiceErrorCode::GIT_UNCOMMITTED_CHANGES, 409),
    (GitServiceErrorCode::GIT_DIVERGED, 409),
    (GitServiceErrorCode::GIT_CONFLICT, 409),
    (GitServiceErrorCode::GIT_NOTHING_TO_COMMIT, 400),
    (GitServiceErrorCode::GIT_REJECTED, 409),
    (GitServiceErrorCode::GIT_NO_UPSTREAM, 400),
    (GitServiceErrorCode::GIT_LOCKED, 409),
    (GitServiceErrorCode::GIT_SSH_MISSING, 502),
    (GitServiceErrorCode::GIT_NO_REMOTE, 400),
    (GitServiceErrorCode::GIT_STALE_DOCUMENT, 409),
    (GitServiceErrorCode::GIT_STALE_STASH, 409),
    (GitServiceErrorCode::GIT_SERVICE_BUSY, 503),
    (GitServiceErrorCode::GIT_RESULT_TOO_LARGE, 413),
    (GitServiceErrorCode::GIT_INVALID_RESULT, 502),
    (GitServiceErrorCode::GIT_UNAVAILABLE, 503),
    (GitServiceErrorCode::GIT_TIMEOUT, 504),
    (GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN, 503),
    (GitServiceErrorCode::GIT_OPERATION_FAILED, 500),
    (GitServiceErrorCode::GIT_MISSING, 501),
    (GitServiceErrorCode::GH_MISSING, 501),
    (GitServiceErrorCode::GH_AUTH_FAILED, 401),
    (GitServiceErrorCode::GH_NO_GITHUB_REMOTE, 400),
    (GitServiceErrorCode::GH_NOT_REPO, 400),
    (GitServiceErrorCode::GH_NOT_FOUND, 404),
    (GitServiceErrorCode::GH_FORBIDDEN, 403),
    (GitServiceErrorCode::GH_NETWORK, 502),
    (GitServiceErrorCode::GH_RATE_LIMITED, 429),
    (GitServiceErrorCode::GH_OPERATION_FAILED, 500),
    (GitServiceErrorCode::GH_STALE_PULL_REQUEST, 409),
    (GitServiceErrorCode::GH_MUTATION_REJECTED, 409),
];

/// Whether `value` names a Git or GitHub service error code.
pub fn is_git_service_error_code(value: &Value) -> Option<GitServiceErrorCode> {
    let text = value.as_str()?;
    GIT_ERROR_STATUS
        .iter()
        .find(|(code, _)| code.as_str() == text)
        .map(|(code, _)| *code)
}

/// The error the Git and GitHub services throw. Its `status` is the HTTP
/// status of its code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitServiceError {
    pub code: GitServiceErrorCode,
    pub message: String,
    pub status: u16,
}

impl GitServiceError {
    pub fn new(code: GitServiceErrorCode, message: impl Into<String>) -> GitServiceError {
        GitServiceError {
            code,
            message: message.into(),
            status: code.status(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_code_is_listed_once() {
        let mut codes: Vec<&str> = GIT_ERROR_STATUS
            .iter()
            .map(|(code, _)| code.as_str())
            .collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total);
        assert_eq!(total, 37);
    }

    #[test]
    fn an_error_carries_the_status_of_its_code() {
        for (code, status) in GIT_ERROR_STATUS {
            let error = GitServiceError::new(*code, "Synthetic failure");
            assert_eq!(error.status, *status, "{code}");
            assert_eq!(error.code, *code);
            assert_eq!(error.to_string(), "Synthetic failure");
            assert_eq!(code.status(), *status);
        }
    }

    #[test]
    fn recognizes_only_the_listed_codes() {
        assert_eq!(
            is_git_service_error_code(&json!("GIT_INVALID_INPUT")),
            Some(GitServiceErrorCode::GIT_INVALID_INPUT)
        );
        assert_eq!(
            is_git_service_error_code(&json!("GH_MUTATION_REJECTED")),
            Some(GitServiceErrorCode::GH_MUTATION_REJECTED)
        );
        // `Object.hasOwn` is false for what an object inherits.
        for value in [
            json!("toString"),
            json!("constructor"),
            json!("hasOwnProperty"),
            json!("__proto__"),
            json!("git_invalid_input"),
            json!(""),
            json!(400),
            json!(null),
            json!(["GIT_INVALID_INPUT"]),
        ] {
            assert_eq!(is_git_service_error_code(&value), None, "{value}");
        }
        assert_eq!(
            GitServiceErrorCode::GH_NOT_FOUND.to_string(),
            "GH_NOT_FOUND"
        );
        assert_eq!(
            serde_json::to_string(&GitServiceErrorCode::GH_NOT_FOUND).unwrap(),
            "\"GH_NOT_FOUND\""
        );
        assert!(garcon_js::json::from_str::<GitServiceErrorCode>("\"NOT_A_CODE\"").is_err());
    }
}
