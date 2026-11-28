//! Ports `server/runtime/files/directory-reader.ts`.

use std::cmp::Ordering;
use std::time::UNIX_EPOCH;

use futures::future::{LocalBoxFuture, try_join_all};
use garcon_base::domain_error::DomainError;
use garcon_base::executor_path::to_executor_path;
use garcon_base::path_boundary::resolve_real_within_canonical_base;
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::file_contracts::{FileTreeBreadcrumb, FileTreeEntry, FileTreeEntryType};
use garcon_interface::files::{ExecutionFileEntry, ExecutionFileList};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, clock::to_iso_string, collation::Collation, path::native};
use tokio::fs;
use tokio_util::sync::CancellationToken;

const MAX_ENTRIES: usize = 10_000;
const MAX_LIST_BYTES: usize = 1024 * 1024;
const DIRECTORY_READ_CONCURRENCY: usize = 16;

fn skip_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "dist" | "build" | ".git" | ".svn" | ".hg"
    )
}

pub fn relative_file_path(root: &str, target: &str) -> String {
    to_executor_path(&native::relative(native::SEP, root, target), None)
}

pub fn file_breadcrumbs(root: &str, target: &str) -> Vec<FileTreeBreadcrumb> {
    let basename = native::basename(root);
    let mut result = vec![FileTreeBreadcrumb {
        name: if basename.is_empty() {
            root.to_owned()
        } else {
            basename
        },
        path: to_executor_path(root, None),
    }];
    let mut current = root.to_owned();
    for segment in native::relative(native::SEP, root, target)
        .split(native::SEP)
        .filter(|part| !part.is_empty())
    {
        current = native::join(&[&current, segment]);
        result.push(FileTreeBreadcrumb {
            name: segment.to_owned(),
            path: to_executor_path(&current, None),
        });
    }
    result
}

fn permissions(mode: u32) -> String {
    (0..9)
        .rev()
        .map(|bit| {
            if mode & (1 << bit) == 0 {
                '-'
            } else {
                ['x', 'w', 'r'][bit % 3]
            }
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Selection {
    All,
    Directories,
}

pub async fn read_file_directory(
    root: &str,
    directory: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Vec<FileTreeEntry>> {
    read_directory(root, directory, Selection::All, signal).await
}

pub async fn read_directory_candidates(
    root: &str,
    directory: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Vec<ExecutionFileEntry>> {
    Ok(
        read_directory(root, directory, Selection::Directories, signal)
            .await?
            .into_iter()
            .map(|entry| ExecutionFileEntry {
                name: entry.name,
                path: entry.path,
                relative_path: None,
                r#type: FileTreeEntryType::Directory,
            })
            .collect(),
    )
}

async fn read_directory(
    root: &str,
    directory: &str,
    selection: Selection,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Vec<FileTreeEntry>> {
    use super::errors::check_cancelled;

    check_cancelled(signal)?;
    let mut handle = fs::read_dir(directory).await?;
    let mut entries = Vec::new();
    let mut batch = Vec::with_capacity(DIRECTORY_READ_CONCURRENCY);
    let mut bytes = 0;
    while let Some(entry) = handle.next_entry().await? {
        check_cancelled(signal)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if selection == Selection::Directories {
            if skip_name(&name) {
                continue;
            }
            let kind = entry.file_type().await?;
            if !kind.is_dir() && !kind.is_symlink() {
                continue;
            }
        }
        batch.push(name);
        if batch.len() == DIRECTORY_READ_CONCURRENCY {
            read_batch(
                root,
                directory,
                selection,
                signal,
                &batch,
                &mut entries,
                &mut bytes,
            )
            .await?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        read_batch(
            root,
            directory,
            selection,
            signal,
            &batch,
            &mut entries,
            &mut bytes,
        )
        .await?;
    }
    check_cancelled(signal)?;
    Ok(tokio::task::spawn_blocking(move || {
        let collation = Collation::english();
        entries.sort_by(|left, right| match (left.r#type, right.r#type) {
            (FileTreeEntryType::Directory, FileTreeEntryType::File) => Ordering::Less,
            (FileTreeEntryType::File, FileTreeEntryType::Directory) => Ordering::Greater,
            _ => collation.compare(&left.name, &right.name),
        });
        entries
    })
    .await?)
}

async fn read_batch(
    root: &str,
    directory: &str,
    selection: Selection,
    signal: Option<&CancellationToken>,
    batch: &[String],
    entries: &mut Vec<FileTreeEntry>,
    bytes: &mut usize,
) -> ExecutorResult<()> {
    let items = try_join_all(
        batch
            .iter()
            .map(|name| read_entry(root, directory, selection, signal, name)),
    )
    .await?;
    for item in items.into_iter().flatten() {
        *bytes += serde_json::to_vec(&item)?.len();
        if entries.len() >= MAX_ENTRIES || *bytes > MAX_LIST_BYTES {
            return Err(DomainError::new(
                ErrorCode::FILE_LIST_TOO_LARGE,
                "Directory contains too many entries to display",
                413,
                false,
            )
            .into());
        }
        entries.push(item);
    }
    Ok(())
}

async fn read_entry(
    root: &str,
    directory: &str,
    selection: Selection,
    signal: Option<&CancellationToken>,
    name: &str,
) -> ExecutorResult<Option<FileTreeEntry>> {
    use super::errors::{check_cancelled, is_skippable_entry_error};

    check_cancelled(signal)?;
    let candidate = native::join(&[directory, name]);
    let stat: ExecutorResult<_> = async {
        resolve_real_within_canonical_base(root, &candidate).await?;
        Ok(fs::metadata(&candidate).await?)
    }
    .await;
    check_cancelled(signal)?;
    let stat = match stat {
        Ok(stat) => stat,
        Err(error) if is_skippable_entry_error(error.as_ref()) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !stat.is_file() && !stat.is_dir() || selection == Selection::Directories && !stat.is_dir() {
        return Ok(None);
    }
    let modified = match stat.modified()?.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(error) => -(error.duration().as_millis() as i64),
    };
    Ok(Some(FileTreeEntry {
        name: name.to_owned(),
        path: to_executor_path(&candidate, None),
        relative_path: relative_file_path(root, &candidate),
        r#type: if stat.is_dir() {
            FileTreeEntryType::Directory
        } else {
            FileTreeEntryType::File
        },
        size: Number(stat.len() as f64),
        modified: Some(to_iso_string(modified)?),
        permissions_rwx: permissions(mode(&stat)),
    }))
}

#[cfg(unix)]
fn mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode()
}

#[cfg(windows)]
fn mode(metadata: &std::fs::Metadata) -> u32 {
    let mode = if metadata.is_dir() { 0o777 } else { 0o666 };
    if metadata.permissions().readonly() {
        mode & !0o222
    } else {
        mode
    }
}

#[derive(Default)]
struct Listing {
    files: Vec<ExecutionFileEntry>,
    bytes: usize,
    visited: usize,
    truncated: bool,
}

pub async fn list_project_files(
    root: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<ExecutionFileList> {
    let mut listing = Listing::default();
    listing.visit(root, root, 0, signal).await?;
    Ok(tokio::task::spawn_blocking(move || {
        let collation = Collation::english();
        listing
            .files
            .sort_by(|left, right| collation.compare(&left.path, &right.path));
        ExecutionFileList {
            files: listing.files,
            truncated: listing.truncated,
        }
    })
    .await?)
}

impl Listing {
    fn visit<'a>(
        &'a mut self,
        root: &'a str,
        directory: &'a str,
        depth: usize,
        signal: Option<&'a CancellationToken>,
    ) -> LocalBoxFuture<'a, ExecutorResult<()>> {
        Box::pin(async move {
            use super::errors::{check_cancelled, is_skippable_entry_error};

            let mut handle = fs::read_dir(directory).await?;
            while let Some(entry) = handle.next_entry().await? {
                check_cancelled(signal)?;
                if self.truncated {
                    return Ok(());
                }
                self.visited += 1;
                if self.visited > MAX_ENTRIES * 4 {
                    self.truncated = true;
                    return Ok(());
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if skip_name(&name) {
                    continue;
                }
                let candidate = native::join(&[directory, &name]);
                let kind = entry.file_type().await?;
                if kind.is_dir() && depth < 10 {
                    let child: ExecutorResult<()> = async {
                        resolve_real_within_canonical_base(root, &candidate).await?;
                        self.visit(root, &candidate, depth + 1, signal).await
                    }
                    .await;
                    if let Err(error) = child {
                        check_cancelled(signal)?;
                        if !is_skippable_entry_error(error.as_ref()) {
                            return Err(error);
                        }
                    }
                } else if kind.is_file() {
                    self.add_file(root, name, candidate)?;
                    if self.truncated {
                        return Ok(());
                    }
                }
            }
            Ok(())
        })
    }

    fn add_file(&mut self, root: &str, name: String, candidate: String) -> ExecutorResult<()> {
        let item = ExecutionFileEntry {
            name,
            path: to_executor_path(&candidate, None),
            relative_path: Some(relative_file_path(root, &candidate)),
            r#type: FileTreeEntryType::File,
        };
        let length = serde_json::to_vec(&item)?.len();
        if self.files.len() >= MAX_ENTRIES || self.bytes + length > MAX_LIST_BYTES {
            self.truncated = true;
        } else {
            self.bytes += length;
            self.files.push(item);
        }
        Ok(())
    }
}
