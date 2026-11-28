//! Ports `server/runtime/git/worktree-porcelain.ts`.

use garcon_interface::resources::ExecutorResult;
use garcon_js::path::native;

use super::run::{read_only_git_options, run_git_traced};
use super::types::{GitCommandOptions, GitCommandResult, GitCommandTrace, GitProcessError};
use super::worktree_record::WorktreeRecord;

fn supports_legacy_porcelain_retry(error: &(dyn std::error::Error + 'static)) -> bool {
    let Some(error) = error.downcast_ref::<GitProcessError>() else {
        return false;
    };
    if error.code == Some(129) {
        return true;
    }
    error
        .stderr
        .to_ascii_lowercase()
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| {
            ["unknown", "unrecognized", "unsupported"]
                .iter()
                .any(|prefix| {
                    line.split_once(prefix).is_some_and(|(_, suffix)| {
                        suffix.contains("-z")
                            || ["switch z", "switch 'z", "switch \"z", "switch `z"]
                                .iter()
                                .any(|arg| suffix.contains(arg))
                    })
                })
        })
}

fn parse_worktree_fields<'a>(fields: impl Iterator<Item = &'a str>) -> Vec<WorktreeRecord> {
    let mut worktrees = Vec::new();
    let mut current: Option<WorktreeRecord> = None;
    for field in fields {
        if let Some(path) = field.strip_prefix("worktree ") {
            let entry = WorktreeRecord {
                path: path.into(),
                branch: String::new(),
                name: String::new(),
                is_main: false,
            };
            if let Some(previous) = current.replace(entry) {
                worktrees.push(previous);
            }
        } else if let Some(worktree) = &mut current {
            if let Some(reference) = field.strip_prefix("branch ") {
                worktree.branch = reference
                    .strip_prefix("refs/heads/")
                    .unwrap_or(reference)
                    .into();
                worktree.name = worktree.branch.clone();
            } else if field == "bare" || field == "detached" {
                if field == "bare" {
                    worktree.is_main = true;
                } else {
                    worktree.branch = "(detached)".into();
                }
                if worktree.name.is_empty() {
                    worktree.name = native::basename(&worktree.path);
                }
            }
        }
    }
    worktrees.extend(current);
    for worktree in &mut worktrees {
        if worktree.name.is_empty() {
            worktree.name = native::basename(&worktree.path);
        }
    }
    if let Some(first) = worktrees.first_mut() {
        first.is_main = true;
    }
    worktrees
}

pub fn parse_worktree_porcelain_z(stdout: &str) -> Vec<WorktreeRecord> {
    parse_worktree_fields(stdout.split('\0'))
}

pub fn parse_worktree_porcelain_lines(stdout: &str) -> Vec<WorktreeRecord> {
    parse_worktree_fields(stdout.split('\n'))
}

pub async fn read_porcelain_worktree_records(
    project_path: &str,
    trace: Option<&mut Vec<GitCommandTrace>>,
) -> ExecutorResult<Vec<WorktreeRecord>> {
    read_porcelain_worktree_records_with(project_path, trace, run_git_traced).await
}

async fn read_porcelain_worktree_records_with(
    project_path: &str,
    mut trace: Option<&mut Vec<GitCommandTrace>>,
    mut run: impl AsyncFnMut(
        &str,
        Vec<String>,
        Option<&mut Vec<GitCommandTrace>>,
        GitCommandOptions,
    ) -> ExecutorResult<GitCommandResult>,
) -> ExecutorResult<Vec<WorktreeRecord>> {
    let args = ["worktree", "list", "--porcelain"];
    let mut nul_args = args.map(str::to_owned).to_vec();
    nul_args.push("-z".into());
    match run(
        project_path,
        nul_args,
        trace.as_deref_mut(),
        read_only_git_options(GitCommandOptions::default()),
    )
    .await
    {
        Ok(output) => Ok(parse_worktree_porcelain_z(&output.stdout)),
        Err(error) if supports_legacy_porcelain_retry(error.as_ref()) => {
            let output = run(
                project_path,
                args.map(str::to_owned).into(),
                trace,
                read_only_git_options(GitCommandOptions::default()),
            )
            .await?;
            Ok(parse_worktree_porcelain_lines(&output.stdout))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NUL_ARGS: [&str; 4] = ["worktree", "list", "--porcelain", "-z"];
    const LEGACY_ARGS: [&str; 3] = ["worktree", "list", "--porcelain"];

    fn output(stdout: &str) -> GitCommandResult {
        GitCommandResult {
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    #[tokio::test]
    async fn uses_nul_framing_when_git_supports_it_for_the_uncaptured_runner_case() {
        let mut calls = Vec::new();
        let records =
            read_porcelain_worktree_records_with("/repo", None, async |cwd, args, _, options| {
                assert_eq!(cwd, "/repo");
                assert!(options.disable_optional_locks);
                calls.push(args);
                Ok(output("worktree /repo\0branch refs/heads/main\0\0"))
            })
            .await
            .unwrap();
        assert_eq!(calls, [NUL_ARGS]);
        assert_eq!((&*records[0].path, &*records[0].branch), ("/repo", "main"));
    }

    #[tokio::test]
    async fn retries_legacy_framing_when_git_rejects_z_for_the_uncaptured_runner_case() {
        let mut calls = Vec::new();
        let records =
            read_porcelain_worktree_records_with("/repo", None, async |_, args, _, options| {
                assert!(options.disable_optional_locks);
                let nul = args == NUL_ARGS;
                calls.push(args);
                if nul {
                    Err(GitProcessError {
                        message: "unknown switch `z'".into(),
                        code: Some(129),
                        stderr: "error: unknown switch `z'".into(),
                        stdout: String::new(),
                        timed_out: None,
                        aborted: None,
                    }
                    .into())
                } else {
                    Ok(output("worktree /repo\nbranch refs/heads/main\n\n"))
                }
            })
            .await
            .unwrap();
        assert_eq!(calls, [NUL_ARGS.to_vec(), LEGACY_ARGS.to_vec()]);
        assert_eq!((&*records[0].path, &*records[0].branch), ("/repo", "main"));
    }

    #[tokio::test]
    async fn does_not_retry_operational_failures_for_the_uncaptured_runner_case() {
        let mut calls = Vec::new();
        let failure = read_porcelain_worktree_records_with("/repo", None, async |_, args, _, _| {
            calls.push(args);
            Err(GitProcessError {
                message: "timed out".into(),
                code: None,
                stderr: String::new(),
                stdout: String::new(),
                timed_out: Some(true),
                aborted: None,
            }
            .into())
        })
        .await
        .unwrap_err();
        assert_eq!(calls, [NUL_ARGS]);
        assert_eq!(failure.to_string(), "timed out");
        assert_eq!(
            failure.downcast_ref::<GitProcessError>().unwrap().timed_out,
            Some(true),
        );
    }
}
