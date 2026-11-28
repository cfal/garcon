//! Ports `server/runtime/git/working-tree-comparison.ts`.

use garcon_contract::git::GIT_REVIEW_DOCUMENT_LIMITS;
use garcon_interface::resources::ExecutorResult;
use garcon_js::path::native;
use tokio::fs::{self, File};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::files::file_revision::close_file;

use super::operation_context::{assert_git_working_path, check_git_cancelled};
use super::run::resolve_path_within_project;

#[derive(Debug)]
pub struct UntrackedSummaryBudget {
    pub remaining_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UntrackedFileSummary {
    pub is_binary: bool,
    pub is_too_large: bool,
    pub unsupported: bool,
    pub additions: usize,
    pub stats_known: bool,
}

impl UntrackedFileSummary {
    const EMPTY: Self = Self {
        is_binary: false,
        is_too_large: false,
        unsupported: false,
        additions: 0,
        stats_known: true,
    };

    const UNSUPPORTED: Self = Self {
        unsupported: true,
        ..Self::EMPTY
    };
}

pub fn create_untracked_summary_budget() -> UntrackedSummaryBudget {
    UntrackedSummaryBudget {
        remaining_bytes: GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_patch_bytes as u64,
    }
}

pub async fn summarize_untracked_file(
    project_path: &str,
    file_path: &str,
    budget: &mut UntrackedSummaryBudget,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<UntrackedFileSummary> {
    match inspect_untracked_file(project_path, file_path, budget, signal).await {
        Err(error) if signal.is_some_and(CancellationToken::is_cancelled) => Err(error),
        Err(_) => Ok(UntrackedFileSummary::UNSUPPORTED),
        Ok(summary) => Ok(summary),
    }
}

async fn inspect_untracked_file(
    project_path: &str,
    file_path: &str,
    budget: &mut UntrackedSummaryBudget,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<UntrackedFileSummary> {
    if let Some(signal) = signal {
        check_git_cancelled(signal)?;
    }
    let resolved = resolve_path_within_project(project_path, file_path)?;
    assert_git_working_path(&native::dirname(&resolved)).await?;
    let path_stats = fs::symlink_metadata(&resolved).await?;
    if let Some(signal) = signal {
        check_git_cancelled(signal)?;
    }
    if !path_stats.is_file() {
        return Ok(UntrackedFileSummary::UNSUPPORTED);
    }

    assert_git_working_path(&resolved).await?;
    let mut handle = File::open(resolved).await?;
    let result = read_file_summary(&mut handle, budget, signal).await;
    close_file(handle).await?;
    result
}

async fn read_file_summary(
    handle: &mut File,
    budget: &mut UntrackedSummaryBudget,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<UntrackedFileSummary> {
    let stats = handle.metadata().await?;
    if !stats.is_file() {
        return Ok(UntrackedFileSummary::UNSUPPORTED);
    }
    let size = stats.len();
    if size > GIT_REVIEW_DOCUMENT_LIMITS.max_file_patch_bytes as u64 {
        return Ok(UntrackedFileSummary {
            is_too_large: true,
            ..UntrackedFileSummary::EMPTY
        });
    }
    let count_additions = size <= budget.remaining_bytes;
    if count_additions {
        budget.remaining_bytes -= size;
    }
    let limit = if count_additions {
        size as usize
    } else {
        size.min(8192) as usize
    };
    let mut buffer = vec![0; limit.clamp(1, 64 * 1024)];
    let mut offset = 0;
    let mut newline_count = 0;
    let mut last_byte = None;
    while offset < limit {
        if let Some(signal) = signal {
            check_git_cancelled(signal)?;
        }
        let count = buffer.len().min(limit - offset);
        let count = handle.read(&mut buffer[..count]).await?;
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        if chunk.contains(&0) {
            return Ok(UntrackedFileSummary {
                is_binary: true,
                ..UntrackedFileSummary::EMPTY
            });
        }
        if count_additions {
            newline_count += chunk.iter().filter(|&&byte| byte == b'\n').count();
            last_byte = chunk.last().copied();
        }
        offset += count;
    }
    let additions = if count_additions && offset > 0 {
        newline_count + usize::from(last_byte != Some(b'\n'))
    } else {
        0
    };
    Ok(UntrackedFileSummary {
        additions,
        stats_known: count_additions,
        ..UntrackedFileSummary::EMPTY
    })
}
