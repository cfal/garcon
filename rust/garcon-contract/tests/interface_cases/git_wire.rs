use std::collections::HashSet;

use garcon_contract::{gh::*, git::*, git_execution::*};
use garcon_js::json::from_str;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::bun::bun_fixtures;

#[derive(Deserialize)]
struct Fixtures {
    requests: Vec<String>,
    results: Vec<(String, String)>,
}

fn assert_wire(name: &str, original: &str, rust: &impl Serialize) {
    let written = serde_json::to_string(rust).unwrap();
    let expected: Value = from_str(original).unwrap();
    let actual: Value = from_str(&written).unwrap();
    assert_eq!(actual, expected, "{name}: {written}");
}

fn round_trip_git<R: DeserializeOwned + Serialize>(name: &str, original: &str) {
    let result: ExecutionGitResult<R> =
        from_str(original).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_wire(name, original, &result);
}

fn round_trip_gh<R: DeserializeOwned + Serialize>(name: &str, original: &str) {
    let result: ExecutionGhResult<R> =
        from_str(original).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_wire(name, original, &result);
}

#[test]
fn git_and_gh_rpc_payloads_round_trip_bun_json() {
    let fixtures: Fixtures = from_str(&bun_fixtures("git-wire-fixtures.ts")).unwrap();
    assert_eq!(fixtures.requests.len(), 54);
    assert_eq!(fixtures.results.len(), 57);
    let mut request_methods = HashSet::new();
    for original in fixtures.requests {
        let wire: Value = from_str(&original).unwrap();
        let name = wire["method"].as_str().unwrap();
        request_methods.insert(name.to_owned());
        if name.starts_with("git.") {
            let rust: ExecutionGitCalls =
                from_str(&original).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(rust.method().rpc_method(), name);
            assert_wire(name, &original, &rust);
        } else {
            let rust: GhCalls =
                from_str(&original).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(rust.method().rpc_method(), name);
            assert_wire(name, &original, &rust);
        }
    }
    let expected_methods: HashSet<_> = GIT_METHODS
        .iter()
        .map(|method| method.rpc_method())
        .chain(GH_METHODS.iter().map(|method| method.rpc_method()))
        .map(str::to_owned)
        .collect();
    assert_eq!(request_methods, expected_methods);

    let mut result_methods = HashSet::new();
    for (method, result) in &fixtures.results {
        let name = method.as_str();
        result_methods.insert(method.clone());
        match name {
            "git.getStatus" => round_trip_git::<GitStatus>(name, result),
            "git.commit" => round_trip_git::<GitCommitResult>(name, result),
            "git.getBranches" => round_trip_git::<GitBranchesResult>(name, result),
            "git.getRefs" => round_trip_git::<GitRefsResponse>(name, result),
            "git.getRemoteStatus" => round_trip_git::<GitRemoteStatus>(name, result),
            "git.getRemotes" => round_trip_git::<GitRemotesResult>(name, result),
            "git.getWorkbenchSnapshot" => {
                round_trip_git::<GitWorkbenchSnapshotResponse>(name, result)
            }
            "git.getWorkingTreeFingerprint" => {
                round_trip_git::<GitWorkingTreeFingerprintResponse>(name, result)
            }
            "git.getQuickSummary" => {
                let typed: ExecutionGitResult<GitQuickSummaryResponse> = from_str(result).unwrap();
                assert_wire(
                    name,
                    result,
                    &ExecutionGitResults {
                        result: GitResults::GetQuickSummary(typed.result),
                        scope: typed.scope,
                        diagnostics: typed.diagnostics,
                    },
                );
            }
            "git.getReviewDocumentFileBodies" => {
                round_trip_git::<GitReviewDocumentFileBodiesResponse>(name, result)
            }
            "git.getHistoryCommits" => round_trip_git::<GitHistoryCommitListResponse>(name, result),
            "git.getCommitSnapshot" => round_trip_git::<GitCommitSnapshotResponse>(name, result),
            "git.getComparisonSnapshot" => {
                round_trip_git::<GitComparisonSnapshotResponse>(name, result)
            }
            "git.getComparisonFreshness" => {
                round_trip_git::<GitComparisonFreshnessResponse>(name, result)
            }
            "git.getConflicts" => round_trip_git::<GitConflictsResult>(name, result),
            "git.getConflictDetails" => round_trip_git::<GitConflictDetails>(name, result),
            "git.getStashes" => round_trip_git::<GitStashesResult>(name, result),
            "git.getFileHistory" => round_trip_git::<GitFileHistoryResult>(name, result),
            "git.getBlame" => round_trip_git::<GitBlameResult>(name, result),
            "git.getGraph" => round_trip_git::<GitGraphResult>(name, result),
            "git.getRepoInfo" => round_trip_git::<RepoInfo>(name, result),
            "git.getWorktrees" => round_trip_git::<GitWorktreesResult>(name, result),
            "git.getTargetCandidates" => round_trip_git::<GitTargetCandidatesResult>(name, result),
            "git.collectCommitMessageContext" => {
                round_trip_git::<GitCommitMessageContextResult>(name, result)
            }
            "gh.getStatus" => round_trip_gh::<GhStatusResponse>(name, result),
            "gh.listPullRequests" => round_trip_gh::<PullRequestListResult>(name, result),
            "gh.getPullRequest" => round_trip_gh::<PullRequestDetail>(name, result),
            "gh.getPullRequestReviewTarget" => {
                round_trip_gh::<PullRequestReviewTarget>(name, result)
            }
            "gh.createPullRequestComment" => round_trip_gh::<PullRequestCommentRef>(name, result),
            "gh.minimizePullRequestComment" => {
                let typed: ExecutionGhResult<PullRequestCommentMinimized> =
                    from_str(result).unwrap();
                assert_wire(
                    name,
                    result,
                    &ExecutionGhResults {
                        result: GhResults::MinimizePullRequestComment(typed.result),
                        scope: typed.scope,
                    },
                );
            }
            _ if GIT_MUTATIONS
                .iter()
                .any(|method| method.rpc_method() == name) =>
            {
                round_trip_git::<GitMutationResult>(name, result);
            }
            _ => panic!("unhandled result for {name}"),
        }
    }
    assert_eq!(result_methods, expected_methods);
}
