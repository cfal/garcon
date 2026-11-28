//! Ports `server/runtime/git/working-path-token.ts`.

use futures::future::try_join_all;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{path::native, utf16};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::operation_context::assert_git_working_path;
use super::pathspecs::chunk_git_pathspecs;
use super::porcelain_status::{PorcelainStatusEntry, parse_porcelain_v1_z};
use super::run::{read_only_git_options, resolve_path_within_project, run_git};
use super::types::GitCommandOptions;
use super::working_tree_observation::GitWorkingTreeObservation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitWorkingPathKind {
    Missing,
    File,
    Symlink,
    Directory,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkingPathToken {
    pub path: String,
    pub index_entry: Option<String>,
    pub status: String,
    pub worktree_kind: GitWorkingPathKind,
    pub worktree_size: Option<String>,
    pub worktree_mtime_ns: Option<String>,
    pub worktree_ctime_ns: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WorkingPathScope {
    #[default]
    WorkingTree,
    Index,
}

#[derive(Default)]
pub struct WorkingPathTokenInputs<'a> {
    pub status_entries: Option<&'a [PorcelainStatusEntry]>,
    pub index_entries_by_path: Option<&'a IndexMap<String, String>>,
    pub scope: WorkingPathScope,
}

fn parse_index_entries(output: &str) -> impl Iterator<Item = (&str, &str)> {
    output
        .split('\0')
        .filter_map(|token| token.split_once('\t').map(|(_, path)| (path, token)))
}

fn status_token(entry: Option<&PorcelainStatusEntry>, scope: WorkingPathScope) -> String {
    if scope == WorkingPathScope::Index {
        return format!("{} \0", entry.map_or(' ', |entry| entry.index_status));
    }
    entry.map_or_else(
        || "  ".into(),
        |entry| {
            format!(
                "{}{}\0{}",
                entry.index_status,
                entry.work_tree_status,
                entry.original_path.as_deref().unwrap_or_default(),
            )
        },
    )
}

struct WorktreeStat {
    kind: GitWorkingPathKind,
    size: String,
    mtime_ns: String,
    ctime_ns: String,
}

fn file_kind(file_type: std::fs::FileType) -> GitWorkingPathKind {
    if file_type.is_file() {
        GitWorkingPathKind::File
    } else if file_type.is_symlink() {
        GitWorkingPathKind::Symlink
    } else if file_type.is_dir() {
        GitWorkingPathKind::Directory
    } else {
        GitWorkingPathKind::Other
    }
}

#[cfg(unix)]
async fn lstat(path: &str) -> std::io::Result<WorktreeStat> {
    use std::os::unix::fs::MetadataExt;

    let metadata = tokio::fs::symlink_metadata(path).await?;
    let nanos =
        |seconds: i64, ns: i64| (i128::from(seconds) * 1_000_000_000 + i128::from(ns)).to_string();
    Ok(WorktreeStat {
        kind: file_kind(metadata.file_type()),
        size: metadata.size().to_string(),
        mtime_ns: nanos(metadata.mtime(), metadata.mtime_nsec()),
        ctime_ns: nanos(metadata.ctime(), metadata.ctime_nsec()),
    })
}

#[cfg(windows)]
async fn lstat(path: &str) -> std::io::Result<WorktreeStat> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    };

    let handle = tokio::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .await?;
    let kind = file_kind(handle.metadata().await?.file_type());
    let stat = crate::files::file_revision::stat_handle(&handle)
        .await?
        .revision;
    Ok(WorktreeStat {
        kind,
        size: stat.size.to_string(),
        mtime_ns: stat.mtime_ns.to_string(),
        ctime_ns: stat.ctime_ns.to_string(),
    })
}

async fn worktree_token(
    project_path: &str,
    file_path: &str,
    entry: Option<&PorcelainStatusEntry>,
) -> ExecutorResult<Option<WorktreeStat>> {
    let resolved = resolve_path_within_project(project_path, file_path)?;
    if entry.is_some_and(|entry| entry.work_tree_status == 'D') {
        return Ok(None);
    }
    assert_git_working_path(&native::dirname(&resolved)).await?;
    Ok(lstat(&resolved).await.ok())
}

pub async fn capture_working_path_tokens(
    project_path: &str,
    paths: &[String],
    inputs: WorkingPathTokenInputs<'_>,
    signal: Option<CancellationToken>,
) -> ExecutorResult<IndexMap<String, GitWorkingPathToken>> {
    let mut unique_paths: Vec<_> = paths
        .iter()
        .filter(|path| !path.is_empty())
        .cloned()
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    unique_paths.sort_by(|left, right| utf16::cmp(left, right));
    let mut loaded_index_entries = IndexMap::new();
    let mut loaded_status_entries = Vec::new();
    if inputs.index_entries_by_path.is_none() || inputs.status_entries.is_none() {
        let options = || {
            read_only_git_options(GitCommandOptions {
                signal: signal.clone(),
                ..Default::default()
            })
        };
        for chunk in chunk_git_pathspecs(&unique_paths) {
            let index = async {
                if inputs.index_entries_by_path.is_some() {
                    return Ok(None);
                }
                run_git(
                    project_path,
                    ["ls-files", "-s", "-z", "--"]
                        .map(str::to_owned)
                        .into_iter()
                        .chain(chunk.iter().cloned())
                        .collect(),
                    options(),
                )
                .await
                .map(Some)
            };
            let status = async {
                if inputs.status_entries.is_some() {
                    return Ok(None);
                }
                run_git(
                    project_path,
                    ["status", "--porcelain=v1", "-z", "--"]
                        .map(str::to_owned)
                        .into_iter()
                        .chain(chunk.iter().cloned())
                        .collect(),
                    options(),
                )
                .await
                .map(Some)
            };
            let (index, status) = tokio::try_join!(biased; index, status)?;
            if let Some(index) = index {
                loaded_index_entries.extend(
                    parse_index_entries(&index.stdout)
                        .map(|(path, token)| (path.to_owned(), token.to_owned())),
                );
            }
            if let Some(status) = status {
                loaded_status_entries.extend(parse_porcelain_v1_z(&status.stdout));
            }
        }
    }
    let index_entries = inputs
        .index_entries_by_path
        .unwrap_or(&loaded_index_entries);
    let status_by_path: IndexMap<_, _> = inputs
        .status_entries
        .unwrap_or(&loaded_status_entries)
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let tokens = try_join_all(unique_paths.into_iter().map(|path| {
        let entry = status_by_path.get(path.as_str()).copied();
        async move {
            let stat = match inputs.scope {
                WorkingPathScope::WorkingTree => worktree_token(project_path, &path, entry).await?,
                WorkingPathScope::Index => None,
            };
            let (kind, size, mtime, ctime) = match stat {
                Some(stat) => (
                    stat.kind,
                    Some(stat.size),
                    Some(stat.mtime_ns),
                    Some(stat.ctime_ns),
                ),
                None => (GitWorkingPathKind::Missing, None, None, None),
            };
            Ok::<_, Box<dyn std::error::Error>>((
                path.clone(),
                GitWorkingPathToken {
                    index_entry: index_entries.get(&path).cloned(),
                    path,
                    status: status_token(entry, inputs.scope),
                    worktree_kind: kind,
                    worktree_size: size,
                    worktree_mtime_ns: mtime,
                    worktree_ctime_ns: ctime,
                },
            ))
        }
    }))
    .await?;
    Ok(tokens.into_iter().collect())
}

pub async fn capture_working_path_tokens_from_observation(
    project_path: &str,
    paths: &[String],
    observation: &GitWorkingTreeObservation,
    scope: WorkingPathScope,
    signal: Option<CancellationToken>,
) -> ExecutorResult<IndexMap<String, GitWorkingPathToken>> {
    let observed: IndexSet<_> = observation.changed_paths.iter().collect();
    let (reusable, needs_index): (Vec<_>, Vec<_>) = paths
        .iter()
        .cloned()
        .partition(|path| observed.contains(path));
    let (mut reused, loaded) = tokio::try_join!(biased;
        capture_working_path_tokens(project_path, &reusable, WorkingPathTokenInputs {
            status_entries: Some(&observation.status_entries),
            index_entries_by_path: Some(&observation.index_entries_by_path),
            scope,
        }, signal.clone()),
        capture_working_path_tokens(project_path, &needs_index, WorkingPathTokenInputs {
            status_entries: Some(&observation.status_entries),
            index_entries_by_path: None,
            scope,
        }, signal),
    )?;
    reused.extend(loaded);
    Ok(reused)
}

pub fn changed_working_path_tokens(
    expected: &IndexMap<String, GitWorkingPathToken>,
    actual: &IndexMap<String, GitWorkingPathToken>,
) -> Vec<String> {
    expected
        .iter()
        .filter(|(path, token)| actual.get(*path) != Some(*token))
        .map(|(path, _)| path.clone())
        .collect()
}
