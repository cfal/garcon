//! Ports `common/git-result-validation.ts`.

use std::collections::HashSet;

use garcon_js::{is_safe_integer, json, number_to_string};
use serde_json::Value;

use crate::gh::GhMethod;
use crate::gh_identity::{is_gh_actor_identity, is_gh_repository_identity};
use crate::git::GitMethod;
use crate::git_error::{GitServiceError, GitServiceErrorCode};
use crate::git_execution::{GIT_MAX_RESULT_BYTES, GitExecutorScope, is_git_mutation};

fn string(v: &Value) -> bool {
    v.is_string()
}

fn boolean(v: &Value) -> bool {
    v.is_boolean()
}

fn number(v: &Value) -> bool {
    json::as_number(v).is_some_and(f64::is_finite)
}

fn one_of<'a>(choices: &'a [&'a str]) -> impl Fn(&Value) -> bool + 'a {
    move |v| v.as_str().is_some_and(|value| choices.contains(&value))
}

fn nullable(check: impl Fn(&Value) -> bool) -> impl Fn(&Value) -> bool {
    move |v| v.is_null() || check(v)
}

fn bounded_array(check: impl Fn(&Value) -> bool, max: usize) -> impl Fn(&Value) -> bool {
    move |v| {
        v.as_array()
            .is_some_and(|items| items.len() <= max && items.iter().all(&check))
    }
}

fn array(check: impl Fn(&Value) -> bool) -> impl Fn(&Value) -> bool {
    bounded_array(check, 100_000)
}

fn map(check: impl Fn(&Value) -> bool, max: usize) -> impl Fn(&Value) -> bool {
    move |v| {
        v.as_object()
            .is_some_and(|items| items.len() <= max && items.values().all(&check))
    }
}

fn field(v: &Value, name: &str, check: impl Fn(&Value) -> bool) -> bool {
    v.get(name).is_some_and(check)
}

fn optional(v: &Value, name: &str, check: impl Fn(&Value) -> bool) -> bool {
    v.get(name).is_none_or(check)
}

macro_rules! shape {
    ($v:ident, $($key:ident $([$optional:ident])? : $check:expr),+ $(,)?) => {
        $v.is_object() $(&& shape!(@field $v, $key $([$optional])?, $check))+
    };
    (@field $v:ident, $key:ident [optional], $check:expr) => {
        optional($v, stringify!($key), $check)
    };
    (@field $v:ident, $key:ident, $check:expr) => {
        field($v, stringify!($key), $check)
    };
}

fn category(v: &Value) -> bool {
    one_of(&["normal", "generated", "lockfile", "binary", "large"])(v)
}

fn body_state(v: &Value) -> bool {
    one_of(&[
        "unloaded",
        "loading",
        "loaded",
        "binary",
        "too-large",
        "error",
    ])(v)
}

fn git_ref(v: &Value) -> bool {
    shape!(v,
        name: string, ref: string,
        kind: one_of(&["local-branch", "remote-branch", "tag", "other"]),
        updatedAt: nullable(string), isCurrent[optional]: boolean,
    )
}

fn limits(v: &Value) -> bool {
    shape!(v,
        maxSummaryFiles: number, maxBodyBatchFiles: number, maxLoadedRows: number,
        maxLoadedPatchBytes: number, maxFileRows: number, maxFilePatchBytes: number,
        maxLineBytes: number, maxContextLines: number, bodyConcurrency: number,
    )
}

fn limit_reason(v: &Value) -> bool {
    one_of(&[
        "collection-too-many-files",
        "collection-too-many-rows",
        "collection-too-many-bytes",
        "file-too-many-rows",
        "file-too-many-bytes",
        "line-too-long",
        "binary",
        "unsupported-file-kind",
        "git-timeout",
    ])(v)
}

fn file_summary(v: &Value) -> bool {
    shape!(v,
        path: string, originalPath[optional]: string, category: category, additions: number,
        deletions: number, estimatedRows: number, bodyState: body_state, bodyFingerprint: string,
        isGenerated: boolean, isBinary: boolean, isTooLarge: boolean, statsKnown[optional]: boolean,
        limitReason[optional]: limit_reason, limitMessage[optional]: string,
    )
}

fn review_file(v: &Value) -> bool {
    file_summary(v) && shape!(v, indexStatus: string, workTreeStatus: string)
}

fn commit_file(v: &Value) -> bool {
    file_summary(v)
        && shape!(v,
            status: one_of(&["added", "modified", "deleted", "renamed", "copied", "type-changed", "unknown"]),
            rawStatus: string,
        )
}

fn target(v: &Value) -> bool {
    shape!(v,
        projectPath: string, repoRoot: string, worktreePath: string, label: string, branch: string,
        source: one_of(&["chat-project", "worktree"]),
    )
}

fn worktree(v: &Value) -> bool {
    shape!(v,
        path: string, branch: string, name: string, isCurrent: boolean, isMain: boolean,
        isPathMissing: boolean, lastModifiedAt: nullable(string),
    )
}

fn commit(v: &Value) -> bool {
    shape!(v,
        hash: string, shortHash: string, parents: array(string), author: string,
        authorEmail: string, authorDate: string, committer: string, committerEmail: string,
        committerDate: string, subject: string, refs: array(string),
    )
}

fn lowercase_hex(v: &Value, length: std::ops::RangeInclusive<usize>) -> bool {
    v.as_str().is_some_and(|s| {
        length.contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn object_id(v: &Value) -> bool {
    lowercase_hex(v, 40..=64)
}

// Called only after each item and its string key have been validated.
fn unique_by(v: &Value, key: &str) -> bool {
    v.as_array().is_some_and(|items| {
        let mut seen = HashSet::with_capacity(items.len());
        items.iter().all(|item| {
            let value = if item.is_object() {
                item.get(key)
            } else {
                Some(item)
            };
            value
                .and_then(Value::as_str)
                .is_some_and(|value| seen.insert(value))
        })
    })
}

fn stash(v: &Value) -> bool {
    shape!(v, index: number, ref: string, hash: object_id, message: string, date: string)
        && json::as_number(&v["index"]).is_some_and(|index| {
            is_safe_integer(index)
                && index >= 0.0
                && v["ref"] == format!("stash@{{{}}}", number_to_string(index))
        })
}

pub fn is_git_patch_body(v: &Value) -> bool {
    shape!(v,
        path: string, bodyFingerprint: string, bodyState: body_state, category: category,
        isBinary: boolean, isTooLarge: boolean, renderedRowCount: number, patchBytes: number,
        patch: nullable(string), patchDigest[optional]: |v| lowercase_hex(v, 64..=64), error[optional]: string,
    )
}

fn tree(v: &Value, depth: usize) -> bool {
    depth < 128
        && shape!(v,
            path: string, name: string, kind: one_of(&["file", "directory"]),
            children[optional]: array(|child| tree(child, depth + 1)),
        )
}

fn commit_document(v: &Value) -> bool {
    shape!(v,
        documentId: string, files: bounded_array(commit_file, 10_000), limits: limits,
        firstBodyCandidates: bounded_array(string, 24),
    )
}

fn revision(v: &Value) -> bool {
    shape!(v, kind: one_of(&["revision"]), requestedRevision: string, label: string, hash: string, shortHash: string)
}

fn working_tree(v: &Value) -> bool {
    shape!(v, kind: one_of(&["working-tree"]), label: string, branch: string, headHash: nullable(string),
        fingerprint: string, shortFingerprint: string)
}

fn diagnostics(v: &Value) -> bool {
    shape!(v,
        commands: bounded_array(
            |c| shape!(c, command: string, durationMs: number, stdoutBytes: number, stderrBytes: number),
            128,
        ),
        phases: bounded_array(
            |p| shape!(p, name: one_of(&["resolve", "summary-git", "document-register", "freshness-before",
                "body-cache", "body-git", "body-split", "patch-scan", "freshness-after", "serialize"]),
                durationMs: number),
            128,
        ),
        fileCount[optional]: number, rowCount[optional]: number, cacheHits[optional]: number,
        batchCount[optional]: number, bisectionCount[optional]: number,
    )
}

fn scope_matches(v: &Value, scope: &GitExecutorScope) -> bool {
    v.is_object() && v["executorId"] == scope.executor_id && v["instanceId"] == scope.instance_id
}

pub fn validate_git_result(
    method: GitMethod,
    value: &Value,
    scope: &GitExecutorScope,
) -> Result<(), GitServiceError> {
    if json::stringify(value).len() > GIT_MAX_RESULT_BYTES {
        return Err(if is_git_mutation(method) {
            GitServiceError::new(
                GitServiceErrorCode::GIT_MUTATION_OUTCOME_UNKNOWN,
                "Git mutation result exceeds the 4 MiB limit. Inspect the repository before trying again.",
            )
        } else {
            GitServiceError::new(
                GitServiceErrorCode::GIT_RESULT_TOO_LARGE,
                "Git query result exceeds the 4 MiB limit",
            )
        });
    }
    if !scope_matches(value, scope)
        || !optional(value, "diagnostics", diagnostics)
        || !git_result(method, value)
    {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_INVALID_RESULT,
            format!("Invalid Git {} response", method.as_str()),
        ));
    }
    Ok(())
}

fn git_result(method: GitMethod, v: &Value) -> bool {
    use GitMethod::*;
    if is_git_mutation(method) {
        return shape!(v, success: |value| *value == true, output[optional]: string,
            message[optional]: string, outputTruncated[optional]: boolean, worktreePath[optional]: string)
            && (method != Commit
                || shape!(v, commitScope: one_of(&["selected-files", "whole-index"]), indexSynchronized: boolean));
    }
    match method {
        GetStatus => shape!(v, branch: string, hasCommits: boolean, modified: array(string),
            added: array(string), deleted: array(string), untracked: array(string)),
        GetBranches => field(v, "branches", array(string)),
        GetRefs => field(v, "refs", bounded_array(git_ref, 500)),
        GetRemoteStatus => shape!(v, branch: string, hasRemote: boolean, hasUpstream: boolean,
            remoteName: nullable(string), remoteBranch[optional]: string, ahead[optional]: number,
            behind[optional]: number, isUpToDate[optional]: boolean),
        GetRemotes => field(
            v,
            "remotes",
            array(|x| shape!(x, name: string, url: string)),
        ),
        GetRepoInfo => {
            shape!(v, isGitRepository: boolean, repoRoot[optional]: string, currentWorktreePath[optional]: string)
        }
        GetWorktrees => field(v, "worktrees", array(worktree)),
        GetTargetCandidates => field(
            v,
            "targets",
            array(|x| target(x) && shape!(x, isCurrent: boolean, isMissing: boolean)),
        ),
        CollectCommitMessageContext => field(v, "diff", string),
        GetConflicts => field(
            v,
            "conflicts",
            array(|x| {
                shape!(x, path: string,
            status: one_of(&["UU", "AA", "DD", "AU", "UA", "DU", "UD"]),
            baseAvailable: boolean, oursAvailable: boolean, theirsAvailable: boolean)
            }),
        ),
        GetConflictDetails => {
            let content = |x: &Value| shape!(x, content: nullable(string), truncated: boolean, byteLength: number, lineCount: number);
            shape!(v, path: string, base: content, ours: content, theirs: content, working: content, truncated: boolean)
        }
        GetStashes => field(v, "stashes", array(stash)) && unique_by(&v["stashes"], "ref"),
        GetFileHistory => {
            field(
                v,
                "commits",
                array(|x| {
                    shape!(x, hash: object_id, author: string,
            email: string, date: string, subject: string)
                }),
            ) && unique_by(&v["commits"], "hash")
        }
        GetGraph => field(
            v,
            "commits",
            array(|x| {
                shape!(x, graph: string, hash: string, parents: array(string),
            decorations: array(string), author: string, date: string, subject: string)
            }),
        ),
        GetBlame => {
            shape!(v, truncated: boolean, lines: array(|x| shape!(x, line: number, originalLine: number,
            finalLine: number, commit: string, author: string, authorMail: string, authorTime: string,
            summary: string, content: string)))
        }
        GetHistoryCommits => {
            shape!(v, project: string, ref: string, nextOffset: nullable(number), commits: bounded_array(commit, 200))
        }
        GetWorkingTreeFingerprint => {
            field(v, "project", string)
                && json::as_number(&v["fingerprintVersion"]) == Some(1.0)
                && if v["status"] == "ready" {
                    shape!(v, fingerprint: string, changedPathCount: number)
                } else {
                    one_of(&["not-git-repository", "unknown"])(&v["status"])
                        && v.get("fingerprint") == Some(&Value::Null)
                        && field(v, "message", string)
                }
        }
        GetQuickSummary => {
            field(v, "project", string)
                && if v["status"] == "ready" {
                    shape!(v, branch: string, hasChanges: boolean, hasUntracked: boolean,
                diffStats: nullable(|x| shape!(x, additions: number, deletions: number)))
                } else {
                    one_of(&["not-git-repository", "unknown"])(&v["status"])
                        && field(v, "message", string)
                }
        }
        GetWorkbenchSnapshot => {
            field(v, "project", string)
                && if v["status"] == "not-git-repository" {
                    ["target", "tree", "reviewSummary"]
                        .iter()
                        .all(|key| v.get(*key) == Some(&Value::Null))
                        && field(v, "message", string)
                } else {
                    v["status"] == "ready"
                        && shape!(v, target: target,
                tree: |x| shape!(x, root: array(|item| tree(item, 0)), hasCommits: boolean, statsState: one_of(&["loaded"])),
                reviewSummary: |x| shape!(x, documentId: string, project: string, mode: one_of(&["working", "staged"]),
                    context: number, files: bounded_array(review_file, 10_000), limits: limits),
                selectedFile: nullable(string), firstBodyCandidates: bounded_array(string, 24), snapshotId: string,
                workbenchFingerprint: string)
                }
        }
        GetReviewDocumentFileBodies => {
            field(v, "documentId", string)
                && match v["status"].as_str() {
                    Some("ready") => {
                        shape!(v, files: map(is_git_patch_body, 24), errors: map(string, 24),
                deferredFiles: bounded_array(string, 24))
                            && unique_by(&v["deferredFiles"], "path")
                            && v["deferredFiles"].as_array().is_some_and(|paths| {
                                paths.iter().all(|path| {
                                    path.as_str()
                                        .is_some_and(|path| v["files"].get(path).is_none())
                                })
                            })
                    }
                    Some("document-expired") => field(v, "message", string),
                    Some("stale") => shape!(v, changedPaths: array(string), message: string),
                    _ => false,
                }
        }
        GetCommitSnapshot => {
            field(v, "project", string)
                && if v["status"] == "not-found" {
                    shape!(v, commit: string, message: string)
                } else {
                    v["status"] == "ready"
                        && commit_document(v)
                        && shape!(v, commit: |x| commit(x) && field(x, "body", string),
                selectedParent: nullable(string), parentOptions: array(|x| shape!(x, hash: string, shortHash: string, label: string)))
                }
        }
        GetComparisonSnapshot => {
            field(v, "project", string)
                && match v["status"].as_str() {
                    Some("ready") => {
                        commit_document(v)
                            && shape!(v, repoRoot: string, mode: one_of(&["direct", "merge-base"]),
                from: revision, to: |x| revision(x) || working_tree(x), effectiveFromHash: string)
                    }
                    Some("not-found") => {
                        shape!(v, endpoint: one_of(&["from", "to"]), revision: string, message: string)
                    }
                    Some("no-merge-base") => {
                        shape!(v, from: revision, to: revision, message: string)
                    }
                    Some("working-tree-changing") => field(v, "message", string),
                    _ => false,
                }
        }
        GetComparisonFreshness => {
            field(v, "project", string)
                && if v["status"] == "not-found" {
                    shape!(v, endpoint: one_of(&["from", "to"]), revision: string, message: string)
                } else {
                    v["status"] == "ready"
                        && shape!(v, changedEndpoints: bounded_array(one_of(&["from", "to"]), 2),
                fromHash: string, to: |x| shape!(x, kind: one_of(&["revision"]), hash: string)
                    || shape!(x, kind: one_of(&["working-tree"]), fingerprint: string))
                }
        }
        _ => false,
    }
}

fn pr_state(v: &Value) -> bool {
    one_of(&["open", "closed", "merged"])(v)
}

fn pr_identity(v: &Value) -> bool {
    shape!(v,
        number: number, title: string, state: pr_state, isDraft: boolean, author: string, headRefName: string,
        baseRefName: string, additions: number, deletions: number, changedFiles: number, createdAt: string,
        updatedAt: string, url: string, headRefOid: string,
        reviewDecision: nullable(one_of(&["approved", "changes_requested", "review_required"])),
    )
}

fn gh_result(method: GhMethod, v: &Value) -> bool {
    match method {
        GhMethod::GetStatus => shape!(v, available: boolean, authenticated: boolean,
            reason: one_of(&["authenticated", "unauthenticated", "gh_missing", "auth_error", "unknown"]),
            login[optional]: string, host[optional]: string),
        GhMethod::ListPullRequests => shape!(v,
            pulls: array(|x| pr_identity(x) && shape!(x,
                checksState: one_of(&["passing", "failing", "pending", "none"]), isCrossRepository: boolean,
                authorAssociation: one_of(&["owner", "member", "collaborator", "contributor",
                    "first_time_contributor", "first_timer", "mannequin", "none"]),
                authorIsBot: boolean, authoredByViewer: boolean, labels: array(string),
                reviewRequest: nullable(one_of(&["me", "team"])))),
            repo: nullable(|x| shape!(x, nameWithOwner: string, url: string)), viewerLogin: nullable(string)),
        GhMethod::GetPullRequestReviewTarget => shape!(v,
            repository: is_gh_repository_identity, viewer: is_gh_actor_identity, number: number, state: pr_state, headRefOid: string,
            markedComments: array(|x| shape!(x, id: string, url: string, marker: string, isMinimized: boolean,
                author: nullable(is_gh_actor_identity)))),
        GhMethod::CreatePullRequestComment => shape!(v, id: string, url: string),
        GhMethod::MinimizePullRequestComment => field(v, "minimized", boolean),
        GhMethod::GetPullRequest => {
            pr_identity(v)
                && shape!(v,
            body: string, mergeable: one_of(&["mergeable", "conflicting", "unknown"]),
            files: bounded_array(review_file, 10_000), fileBodies: map(is_git_patch_body, 10_000),
            checks: array(|x| shape!(x, name: string,
                state: one_of(&["success", "failure", "pending", "neutral", "skipped"]), url[optional]: string)),
            threads: array(|x| shape!(x, id: string, path: string, side: one_of(&["before", "after"]),
                line: number, diffHunk: string, isOutdated: boolean,
                comments: array(|c| shape!(c, id: number, author: string, body: string, createdAt: string)))))
        }
    }
}

pub fn validate_gh_result(
    method: GhMethod,
    value: &Value,
    scope: &GitExecutorScope,
) -> Result<(), GitServiceError> {
    if json::stringify(value).len() > GIT_MAX_RESULT_BYTES {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_RESULT_TOO_LARGE,
            "GitHub query result exceeds the 4 MiB limit",
        ));
    }
    if !scope_matches(value, scope) {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_INVALID_RESULT,
            format!("Invalid GitHub {} response scope", method.as_str()),
        ));
    }
    if !gh_result(method, value) {
        return Err(GitServiceError::new(
            GitServiceErrorCode::GIT_INVALID_RESULT,
            format!("Invalid GitHub {} response", method.as_str()),
        ));
    }
    Ok(())
}
