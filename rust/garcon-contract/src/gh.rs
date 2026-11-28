//! Ports `common/gh.ts`.
//!
//! The pull request documents a GitHub call returns are not ported yet; this
//! holds the identities a call names, the calls themselves, and the limits.

use serde::{Deserialize, Serialize};

/// The GitHub host a repository lives on and its `owner/name`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepositoryIdentity {
    pub host: String,
    pub name_with_owner: String,
}

/// A GitHub account, by the ID GitHub reports and its login.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhActorIdentity {
    pub id: String,
    pub login: String,
}

/// One GitHub call, named as the GitHub routes and the executor link name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GhMethod {
    GetStatus,
    ListPullRequests,
    GetPullRequest,
    GetPullRequestReviewTarget,
    CreatePullRequestComment,
    MinimizePullRequestComment,
}

/// Every GitHub call, in the order the original lists them.
pub const GH_METHODS: &[GhMethod] = &[
    GhMethod::GetStatus,
    GhMethod::ListPullRequests,
    GhMethod::GetPullRequest,
    GhMethod::GetPullRequestReviewTarget,
    GhMethod::CreatePullRequestComment,
    GhMethod::MinimizePullRequestComment,
];

impl GhMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            GhMethod::GetStatus => "getStatus",
            GhMethod::ListPullRequests => "listPullRequests",
            GhMethod::GetPullRequest => "getPullRequest",
            GhMethod::GetPullRequestReviewTarget => "getPullRequestReviewTarget",
            GhMethod::CreatePullRequestComment => "createPullRequestComment",
            GhMethod::MinimizePullRequestComment => "minimizePullRequestComment",
        }
    }
}

/// The GitHub calls that change something on GitHub.
pub const GH_MUTATIONS: &[GhMethod] = &[
    GhMethod::CreatePullRequestComment,
    GhMethod::MinimizePullRequestComment,
];

pub fn is_gh_mutation(method: GhMethod) -> bool {
    GH_MUTATIONS.contains(&method)
}

// GitHub rejects issue comments longer than this many characters.
pub const GH_COMMENT_BODY_MAX_LENGTH: usize = 65_536;
pub const GH_COMMENT_MARKER_MAX_LENGTH: usize = 256;
pub const GH_COMMENT_ID_MAX_LENGTH: usize = 256;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_call_keeps_its_name_on_the_wire() {
        assert_eq!(GH_METHODS.len(), 6);
        for method in GH_METHODS {
            assert_eq!(json!(method), json!(method.as_str()), "{method:?}");
            assert_eq!(
                serde_json::from_value::<GhMethod>(json!(method.as_str())).unwrap(),
                *method
            );
        }
        for method in GH_METHODS {
            assert_eq!(
                is_gh_mutation(*method),
                *method == GhMethod::CreatePullRequestComment
                    || *method == GhMethod::MinimizePullRequestComment,
                "{method:?}"
            );
        }
    }
}
