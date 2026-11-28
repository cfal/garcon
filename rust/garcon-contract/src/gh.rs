//! Ports `common/gh.ts`.
use garcon_js::Number;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::git::{GitCall, GitReviewFilePatchBody, GitReviewFileSummary};

/// The GitHub host a repository lives on and its `owner/name`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepositoryIdentity {
    pub host: String,
    pub name_with_owner: String,
}

/// A GitHub account, by the ID GitHub reports and its login.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhActorIdentity {
    pub id: String,
    pub login: String,
}

macro_rules! gh_methods {
    ($($variant:ident, $name:literal, $rpc:literal, $input:ty, $output:ty);+ $(;)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum GhMethod {
            $(#[serde(rename = $name)] $variant),+
        }

        pub const GH_METHODS: &[GhMethod] = &[$(GhMethod::$variant),+];

        impl GhMethod {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $name),+ }
            }

            pub const fn rpc_method(self) -> &'static str {
                match self { $(Self::$variant => $rpc),+ }
            }
        }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(tag = "method", content = "request")]
        pub enum GhRequests {
            $(#[serde(rename = $name)] $variant($input)),+
        }

        impl GhRequests {
            pub const fn method(&self) -> GhMethod {
                match self { $(Self::$variant(_) => GhMethod::$variant),+ }
            }
        }

        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "method", content = "request")]
        pub enum GhCalls {
            $(#[serde(rename = $rpc)] $variant(GitCall<$input>)),+
        }

        impl GhCalls {
            pub const fn method(&self) -> GhMethod {
                match self { $(Self::$variant(_) => GhMethod::$variant),+ }
            }
        }

        #[derive(Debug, Clone, PartialEq, Serialize)]
        #[serde(untagged)]
        pub enum GhResults {
            $($variant($output)),+
        }
    };
}

gh_methods! {
    GetStatus, "getStatus", "gh.getStatus", GhStatusRequest, GhStatusResponse;
    ListPullRequests, "listPullRequests", "gh.listPullRequests", ListPullRequestsRequest, PullRequestListResult;
    GetPullRequest, "getPullRequest", "gh.getPullRequest", GetPullRequestRequest, Box<PullRequestDetail>;
    GetPullRequestReviewTarget, "getPullRequestReviewTarget", "gh.getPullRequestReviewTarget", GetPullRequestReviewTargetRequest, PullRequestReviewTarget;
    CreatePullRequestComment, "createPullRequestComment", "gh.createPullRequestComment", CreatePullRequestCommentRequest, PullRequestCommentRef;
    MinimizePullRequestComment, "minimizePullRequestComment", "gh.minimizePullRequestComment", MinimizePullRequestCommentRequest, PullRequestCommentMinimized;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GhAvailabilityReason {
    Authenticated,
    Unauthenticated,
    GhMissing,
    AuthError,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GhStatusResponse {
    pub available: bool,
    pub authenticated: bool,
    pub reason: GhAvailabilityReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GhStatusRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPullRequestsRequest {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<GhRepositoryIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPullRequestRequest {
    pub project_path: String,
    pub repository: GhRepositoryIdentity,
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPullRequestReviewTargetRequest {
    pub project_path: String,
    pub repository: GhRepositoryIdentity,
    pub number: u64,
    pub marker: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestReviewState {
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCommentExpectation {
    pub state: PullRequestReviewState,
    pub head_ref_oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestCommentRequest {
    pub project_path: String,
    pub repository: GhRepositoryIdentity,
    pub actor: GhActorIdentity,
    pub number: u64,
    pub body: String,
    pub expected: PullRequestCommentExpectation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimizePullRequestCommentRequest {
    pub project_path: String,
    pub repository: GhRepositoryIdentity,
    pub actor: GhActorIdentity,
    pub comment_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestChecksState {
    Passing,
    Failing,
    Pending,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestAuthorAssociation {
    Owner,
    Member,
    Collaborator,
    Contributor,
    FirstTimeContributor,
    FirstTimer,
    Mannequin,
    None,
}

pub const PULL_REQUEST_AUTHOR_ASSOCIATIONS: &[PullRequestAuthorAssociation] = &[
    PullRequestAuthorAssociation::Owner,
    PullRequestAuthorAssociation::Member,
    PullRequestAuthorAssociation::Collaborator,
    PullRequestAuthorAssociation::Contributor,
    PullRequestAuthorAssociation::FirstTimeContributor,
    PullRequestAuthorAssociation::FirstTimer,
    PullRequestAuthorAssociation::Mannequin,
    PullRequestAuthorAssociation::None,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestReviewRequest {
    Me,
    Team,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestMergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestThreadSide {
    Before,
    After,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestCheckState {
    Success,
    Failure,
    Pending,
    Neutral,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: Number,
    pub title: String,
    pub state: PullRequestState,
    pub is_draft: bool,
    pub author: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub additions: Number,
    pub deletions: Number,
    pub changed_files: Number,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub review_decision: Option<PullRequestReviewDecision>,
    pub checks_state: PullRequestChecksState,
    pub head_ref_oid: String,
    pub is_cross_repository: bool,
    pub author_association: PullRequestAuthorAssociation,
    pub author_is_bot: bool,
    pub authored_by_viewer: bool,
    pub labels: Vec<String>,
    pub review_request: Option<PullRequestReviewRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestRepository {
    pub name_with_owner: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestListResult {
    pub pulls: Vec<PullRequestSummary>,
    pub repo: Option<PullRequestRepository>,
    pub viewer_login: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCommentRef {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestMarkedComment {
    #[serde(flatten)]
    pub comment: PullRequestCommentRef,
    pub marker: String,
    pub is_minimized: bool,
    pub author: Option<GhActorIdentity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewTarget {
    pub repository: GhRepositoryIdentity,
    pub viewer: GhActorIdentity,
    pub number: Number,
    pub state: PullRequestState,
    pub head_ref_oid: String,
    pub marked_comments: Vec<PullRequestMarkedComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCommentMinimized {
    pub minimized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewCommentItem {
    pub id: Number,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestThread {
    pub id: String,
    pub path: String,
    pub side: PullRequestThreadSide,
    pub line: Number,
    pub diff_hunk: String,
    pub is_outdated: bool,
    pub comments: Vec<PullRequestReviewCommentItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCheck {
    pub name: String,
    pub state: PullRequestCheckState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: Number,
    pub title: String,
    pub body: String,
    pub state: PullRequestState,
    pub is_draft: bool,
    pub author: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub additions: Number,
    pub deletions: Number,
    pub changed_files: Number,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub head_ref_oid: String,
    pub mergeable: PullRequestMergeable,
    pub review_decision: Option<PullRequestReviewDecision>,
    pub checks: Vec<PullRequestCheck>,
    pub files: Vec<GitReviewFileSummary>,
    pub file_bodies: IndexMap<String, GitReviewFilePatchBody>,
    pub threads: Vec<PullRequestThread>,
}

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
