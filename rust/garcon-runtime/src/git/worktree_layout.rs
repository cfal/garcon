//! Ports `server/runtime/git/worktree-layout.ts`.

use garcon_js::path::native;
use serde::Serialize;

use super::run::{read_only_git_options, run_git_traced};
use super::types::{GitCommandOptions, GitCommandTrace};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLayout {
    pub worktree_root: String,
    pub common_dir: String,
    pub ref_format: String,
}

pub fn parse_worktree_layout_probe(stdout: &str) -> Option<WorktreeLayout> {
    let output = stdout.strip_suffix('\n').unwrap_or(stdout);
    let mut lines = output.split('\n');
    let (Some("true"), Some(worktree_root), Some(common_dir), Some(ref_format), None) = (
        lines.next(),
        lines.next(),
        lines.next(),
        lines.next(),
        lines.next(),
    ) else {
        return None;
    };
    if ref_format.is_empty()
        || !native::is_absolute(worktree_root)
        || !native::is_absolute(common_dir)
    {
        return None;
    }
    Some(WorktreeLayout {
        worktree_root: worktree_root.into(),
        common_dir: common_dir.into(),
        ref_format: ref_format.into(),
    })
}

pub async fn probe_worktree_layout(
    project_path: &str,
    trace: Option<&mut Vec<GitCommandTrace>>,
) -> Option<WorktreeLayout> {
    let result = run_git_traced(
        project_path,
        [
            "rev-parse",
            "--is-inside-work-tree",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
            "--show-ref-format",
        ]
        .map(str::to_owned)
        .into(),
        trace,
        read_only_git_options(GitCommandOptions::default()),
    )
    .await
    .ok()?;
    parse_worktree_layout_probe(&result.stdout)
}
