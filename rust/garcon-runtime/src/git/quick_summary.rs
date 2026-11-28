//! Ports `server/runtime/git/quick-summary.ts`.

use std::cell::RefCell;

use garcon_contract::git::{GitQuickSummaryDiffStats, GitQuickSummaryResponse};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, trim, utf16};
use tokio_util::sync::CancellationToken;

use super::diff_file_list::parse_numstat_z;
use super::operation_context::check_git_cancelled;
use super::porcelain_status::parse_porcelain_v1_z;
use super::run::{directory_accessible, read_only_git_options, run_git_traced_shared};
use super::types::{GitCommandOptions, GitCommandResult, GitCommandTrace};

const DIFF_STATS_TIMEOUT_MS: f64 = 2_000.0;
const DIFF_STATS_MAX_BYTES: usize = 1024 * 1024;

pub fn not_repository_quick_summary(project_path: &str) -> GitQuickSummaryResponse {
    GitQuickSummaryResponse::NotGitRepository {
        project: project_path.into(),
        message: "Git is not initialized in this directory.".into(),
    }
}

fn first_detached_ref_label(stdout: &str) -> Option<&str> {
    stdout
        .split('\n')
        .map(trim)
        .find(|line| !line.is_empty() && !line.ends_with("/HEAD"))
}

fn readonly(signal: Option<&CancellationToken>) -> GitCommandOptions {
    read_only_git_options(GitCommandOptions {
        signal: signal.cloned(),
        ..Default::default()
    })
}

fn check_cancelled(signal: Option<&CancellationToken>) -> ExecutorResult<()> {
    if let Some(signal) = signal {
        check_git_cancelled(signal)?;
    }
    Ok(())
}

async fn resolve_branch_label(
    project_path: &str,
    head: &str,
    has_commits: bool,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
    run: &impl AsyncFn(
        &str,
        Vec<String>,
        Option<&RefCell<Vec<GitCommandTrace>>>,
        GitCommandOptions,
    ) -> ExecutorResult<GitCommandResult>,
) -> String {
    if let Ok(result) = run(
        project_path,
        ["symbolic-ref", "--quiet", "--short", "HEAD"]
            .map(str::to_owned)
            .into(),
        trace,
        readonly(signal),
    )
    .await
    {
        let label = trim(&result.stdout);
        if !label.is_empty() {
            return label.into();
        }
    }
    if !has_commits {
        return "main".into();
    }
    if let Ok(result) = run(
        project_path,
        [
            "for-each-ref",
            "--format=%(refname:short)",
            "--points-at",
            "HEAD",
            "refs/remotes",
            "refs/tags",
        ]
        .map(str::to_owned)
        .into(),
        trace,
        readonly(signal),
    )
    .await
        && let Some(label) = first_detached_ref_label(&result.stdout)
    {
        return label.into();
    }
    if let Ok(result) = run(
        project_path,
        ["rev-parse", "--short", "HEAD"].map(str::to_owned).into(),
        trace,
        readonly(signal),
    )
    .await
    {
        let label = trim(&result.stdout);
        if !label.is_empty() {
            return label.into();
        }
    }
    let short = utf16::slice(head, 0, Some(7));
    if short.is_empty() {
        "HEAD".into()
    } else {
        short.into()
    }
}

pub async fn get_quick_summary(
    project_path: &str,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitQuickSummaryResponse> {
    get_quick_summary_with(project_path, trace, signal, &run_git_traced_shared).await
}

pub(super) async fn get_quick_summary_with(
    project_path: &str,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
    run: &impl AsyncFn(
        &str,
        Vec<String>,
        Option<&RefCell<Vec<GitCommandTrace>>>,
        GitCommandOptions,
    ) -> ExecutorResult<GitCommandResult>,
) -> ExecutorResult<GitQuickSummaryResponse> {
    check_cancelled(signal)?;
    if !directory_accessible(project_path).await {
        return Ok(not_repository_quick_summary(project_path));
    }
    let (repository, head, status) = tokio::join!(biased;
        run(project_path, ["rev-parse", "--show-toplevel"].map(str::to_owned).into(), trace, readonly(signal)),
        run(project_path, ["rev-parse", "--verify", "HEAD"].map(str::to_owned).into(), trace, readonly(signal)),
        run(project_path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]
            .map(str::to_owned).into(), trace, readonly(signal)),
    );
    check_cancelled(signal)?;
    if repository.is_err() {
        return Ok(not_repository_quick_summary(project_path));
    }
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            return Ok(GitQuickSummaryResponse::Unknown {
                project: project_path.into(),
                message: error.to_string(),
            });
        }
    };
    let entries = parse_porcelain_v1_z(&status.stdout);
    let has_tracked_changes = entries.iter().any(|entry| entry.index_status != '?');
    let (branch, stats) = tokio::try_join!(biased;
        async {
            Ok(resolve_branch_label(project_path,
                head.as_ref().map_or("", |entry| trim(&entry.stdout)),
                head.is_ok(), trace, signal, run).await)
        },
        async {
            if has_tracked_changes {
                collect_diff_stats(project_path, trace, signal, run).await
            } else {
                Ok(Some(GitQuickSummaryDiffStats { additions: Number(0.0), deletions: Number(0.0) }))
            }
        },
    )?;
    check_cancelled(signal)?;
    Ok(GitQuickSummaryResponse::Ready {
        project: project_path.into(),
        branch,
        has_changes: !entries.is_empty(),
        has_untracked: entries.iter().any(|entry| entry.index_status == '?'),
        diff_stats: stats,
    })
}

async fn collect_diff_stats(
    project_path: &str,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    signal: Option<&CancellationToken>,
    run: &impl AsyncFn(
        &str,
        Vec<String>,
        Option<&RefCell<Vec<GitCommandTrace>>>,
        GitCommandOptions,
    ) -> ExecutorResult<GitCommandResult>,
) -> ExecutorResult<Option<GitQuickSummaryDiffStats>> {
    let options = read_only_git_options(GitCommandOptions {
        signal: signal.cloned(),
        timeout_ms: Some(DIFF_STATS_TIMEOUT_MS),
        max_stdout_bytes: Some(DIFF_STATS_MAX_BYTES),
        ..Default::default()
    });
    let (working, cached) = tokio::join!(biased;
        run(project_path, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]
            .map(str::to_owned).into(), trace, options.clone()),
        run(project_path, ["diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]
            .map(str::to_owned).into(), trace, options),
    );
    check_cancelled(signal)?;
    let (Ok(working), Ok(cached)) = (working, cached) else {
        return Ok(None);
    };
    let totals = |output: &str| {
        parse_numstat_z(output)
            .values()
            .fold((0.0, 0.0), |(adds, deletes), entry| {
                (adds + entry.additions.0, deletes + entry.deletions.0)
            })
    };
    let (working_adds, working_deletes) = totals(&working.stdout);
    let (cached_adds, cached_deletes) = totals(&cached.stdout);
    Ok(Some(GitQuickSummaryDiffStats {
        additions: Number(working_adds + cached_adds),
        deletions: Number(working_deletes + cached_deletes),
    }))
}
