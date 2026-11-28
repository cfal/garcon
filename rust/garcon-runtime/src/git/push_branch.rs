//! Ports `server/runtime/git/push-branch.ts`.

use garcon_interface::resources::ExecutorResult;
use indexmap::IndexSet;

use super::git_domain_error::GitDomainError;
use super::operation_context::{
    git_mutation_dispatched, git_output_truncated, is_git_cancellation,
};
use super::run::run_git;
use super::types::{GitCommandOptions, GitProcessError};

const PUSH_REPORT_MAX_BYTES: usize = 1024 * 1024;
const REJECTION_REASONS: &[&str] = &[
    "[rejected] (non-fast-forward)",
    "[rejected] (fetch first)",
    "[rejected] (already exists)",
    "[rejected] (needs force)",
    "[rejected] (stale info)",
    "[remote rejected] (hook declined)",
    "[remote rejected] (pre-receive hook declined)",
];

struct RefStatus<'a> {
    flag: &'a str,
    pair: &'a str,
    rejection: Option<&'a str>,
}

fn parse_ref_status(line: &str) -> Option<RefStatus<'_>> {
    let mut parts = line.splitn(4, '\t');
    let (flag, pair, summary) = (parts.next()?, parts.next()?, parts.next()?);
    if !matches!(flag, " " | "*" | "+" | "=" | "!" | "-")
        || !pair.contains(":refs/")
        || summary.is_empty()
    {
        return None;
    }
    let rejection = (flag == "!" && parts.next().is_none() && REJECTION_REASONS.contains(&summary))
        .then_some(summary);
    Some(RefStatus {
        flag,
        pair,
        rejection,
    })
}

fn read_push_report<'a>(stdout: &'a str, refspec: &str) -> (bool, IndexSet<&'a str>) {
    let mut lines: Vec<_> = stdout.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(*line);
    }
    let mut confirmed = lines.ends_with(&["Done", ""]);
    let mut rejections = IndexSet::new();
    let mut index = 0;
    while let Some(&line) = lines.get(index) {
        index += 1;
        let mut row = if line.starts_with("To ") {
            lines.get(index).copied().and_then(parse_ref_status)
        } else {
            None
        };
        if row.is_none() {
            if line.ends_with("Done") || parse_ref_status(line).is_some() {
                confirmed = false;
            }
            continue;
        }
        let mut block_rejections = IndexSet::new();
        let mut branch_accepted = false;
        while let Some(status) = row {
            block_rejections.extend(status.rejection);
            if status.pair == refspec {
                branch_accepted = matches!(status.flag, "*" | " " | "=");
            }
            index += 1;
            row = lines.get(index).copied().and_then(parse_ref_status);
        }
        if lines.get(index) != Some(&"Done") || index == last {
            confirmed = false;
            continue;
        }
        index += 1;
        rejections.extend(block_rejections);
        if !branch_accepted {
            confirmed = false;
        }
    }
    (confirmed, rejections)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PushExit {
    ExitedZero,
    Failed,
    Interrupted,
}

pub async fn push_branch_ref(
    project_path: &str,
    remote: &str,
    reference: &str,
    options: GitCommandOptions,
) -> ExecutorResult<()> {
    let refspec = format!("{reference}:{reference}");
    let mut args = vec![
        "push".into(),
        "--porcelain".into(),
        remote.into(),
        refspec.clone(),
    ];
    args.extend(
        ["refs", "refs/heads", "refs/remotes"].map(|prefix| format!("^{prefix}/{reference}*")),
    );
    let options = GitCommandOptions {
        max_stdout_bytes: Some(PUSH_REPORT_MAX_BYTES),
        max_stderr_bytes: Some(0),
        ..options
    };
    let (stdout, exit) = match run_git(project_path, args, options).await {
        Ok(output) => (output.stdout, PushExit::ExitedZero),
        Err(error) => {
            let captured = error
                .downcast_ref::<GitProcessError>()
                .map(|error| &error.stdout);
            let interrupted = is_git_cancellation(error.as_ref());
            if !git_mutation_dispatched() && (captured.is_none() || interrupted) {
                return Err(error);
            }
            (
                captured.cloned().unwrap_or_default(),
                if interrupted {
                    PushExit::Interrupted
                } else {
                    PushExit::Failed
                },
            )
        }
    };
    let (confirmed, rejections) = read_push_report(&stdout, &refspec);
    let truncated = git_output_truncated();
    if exit == PushExit::ExitedZero && confirmed && !truncated {
        return Ok(());
    }
    let mut lines = vec!["Git did not confirm the push. Inspect the remote before pushing again."];
    if exit == PushExit::Interrupted {
        lines.push("Git push was cancelled or timed out.");
    }
    if truncated {
        lines.push("Git push output was truncated.");
    }
    lines.extend(rejections);
    Err(GitDomainError::new("MUTATION_OUTCOME_UNKNOWN", lines.join("\n")).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_complete_push_blocks_contribute_public_rejection_reasons() {
        let reference = "refs/heads/main:refs/heads/main";
        let report = format!(
            "To incomplete\n!\t{reference}\t[rejected] (needs force)\nTo first\n\
            !\t{reference}\t[rejected] (fetch first)\n\
            !\trefs/tags/v1:refs/tags/v1\t[remote rejected] (custom receiver detail)\n\
            !\trefs/tags/v2:refs/tags/v2\t[remote rejected] (hook declined)\textra field\n\
            Done\nTo second\n!\t{reference}\t[rejected] (non-fast-forward)\nDone"
        );
        let (confirmed, rejections) = read_push_report(&report, reference);
        assert!(!confirmed);
        assert_eq!(
            rejections.into_iter().collect::<Vec<_>>(),
            ["[rejected] (fetch first)"]
        );
    }
}
