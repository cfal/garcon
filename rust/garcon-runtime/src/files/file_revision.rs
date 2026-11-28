//! Ports `server/runtime/files/file-revision.ts`.

use std::io;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use garcon_base::domain_error::DomainError;
use garcon_base::file_stat;
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::file_contracts::{FileRevision, MAX_FILE_VIEW_BYTES};
use garcon_interface::resources::ExecutorResult;
use sha2::{Digest, Sha256};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::errors::is_missing;

pub const FILE_CHANGED_DURING_READ: ErrorCode = ErrorCode::FILE_CHANGED_DURING_READ;
pub const FILE_PATH_MUST_IDENTIFY_FILE: ErrorCode = ErrorCode::FILE_PATH_MUST_IDENTIFY_FILE;
pub const FILE_TOO_LARGE: ErrorCode = ErrorCode::FILE_TOO_LARGE;

fn file_changed_during_read() -> DomainError {
    DomainError::new(
        FILE_CHANGED_DURING_READ,
        "File changed repeatedly while it was being read",
        409,
        true,
    )
}

fn file_path_must_identify_file() -> DomainError {
    DomainError::new(
        FILE_PATH_MUST_IDENTIFY_FILE,
        "File path must identify a file",
        400,
        false,
    )
}

pub(super) fn file_too_large(max_bytes: usize) -> DomainError {
    let limit = garcon_js::number_to_string(max_bytes as f64 / (1024.0 * 1024.0));
    DomainError::new(
        FILE_TOO_LARGE,
        format!("File exceeds the {limit} MB viewer limit"),
        413,
        false,
    )
}

pub use garcon_base::file_stat::FileIdentity as RevisionStat;

pub fn revision_from_stat(stat: RevisionStat) -> FileRevision {
    let source = format!(
        "{}:{}:{}:{}:{}",
        stat.dev, stat.ino, stat.size, stat.mtime_ns, stat.ctime_ns
    );
    format!("v1:{}", URL_SAFE_NO_PAD.encode(Sha256::digest(source)))
}

pub(crate) struct FileStat {
    pub revision: RevisionStat,
    pub is_file: bool,
}

impl From<file_stat::FileStat> for FileStat {
    fn from(stat: file_stat::FileStat) -> Self {
        Self {
            revision: stat.identity,
            is_file: stat.is_file,
        }
    }
}

fn revision_for_file_stat(stat: &FileStat) -> Result<FileRevision, DomainError> {
    if !stat.is_file {
        return Err(file_path_must_identify_file());
    }
    Ok(revision_from_stat(stat.revision))
}

pub async fn get_file_revision(file_path: &str) -> ExecutorResult<FileRevision> {
    Ok(revision_for_file_stat(&stat_path(file_path).await?)?)
}

pub async fn get_file_revision_or_missing(file_path: &str) -> ExecutorResult<Option<FileRevision>> {
    match get_file_revision(file_path).await {
        Ok(revision) => Ok(Some(revision)),
        Err(error) if is_missing(error.as_ref()) => Ok(None),
        Err(error) => Err(error),
    }
}

pub async fn get_file_lock_key(file_path: &str) -> ExecutorResult<String> {
    match stat_path(file_path).await {
        Ok(stat) => {
            revision_for_file_stat(&stat)?;
            Ok(format!("inode:{}:{}", stat.revision.dev, stat.revision.ino))
        }
        Err(error) if is_missing(&error) => Ok(format!("path:{file_path}")),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct VersionedReadOptions {
    pub max_attempts: usize,
    pub max_bytes: usize,
}

impl Default for VersionedReadOptions {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            max_bytes: MAX_FILE_VIEW_BYTES,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct VersionedFile {
    pub bytes: Vec<u8>,
    pub revision: FileRevision,
}

pub async fn write_versioned_text_file(
    file_path: &str,
    content: &str,
) -> ExecutorResult<FileRevision> {
    let mut open = OpenOptions::new();
    open.write(true).create(true);
    #[cfg(unix)]
    open.truncate(true)
        .mode(0o666)
        .custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    open.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let mut handle = open.open(file_path).await?;
    #[cfg(windows)]
    if handle.metadata().await?.is_symlink() {
        return Err(io::Error::from_raw_os_error(1921).into());
    }
    let result: ExecutorResult<_> = async {
        #[cfg(windows)]
        handle.set_len(0).await?;
        handle.write_all(content.as_bytes()).await?;
        handle.flush().await?;
        Ok(revision_for_file_stat(&stat_handle(&handle).await?)?)
    }
    .await;
    let close = close_file(handle).await;
    close.map_err(Into::into).and(result).map_err(|error| {
        DomainError::new(
            ErrorCode::FILE_SAVE_OUTCOME_UNKNOWN,
            "Save could not be confirmed. Reload the file before saving again.",
            503,
            false,
        )
        .with_cause(error)
        .into()
    })
}

pub async fn read_versioned_file(
    file_path: &str,
    options: VersionedReadOptions,
) -> ExecutorResult<VersionedFile> {
    read_versioned(file_path, options, || std::future::ready(Ok(()))).await
}

async fn read_versioned<F: Future<Output = io::Result<()>>>(
    file_path: &str,
    options: VersionedReadOptions,
    mut after_read: impl FnMut() -> F,
) -> ExecutorResult<VersionedFile> {
    for _ in 0..options.max_attempts {
        let mut open = OpenOptions::new();
        open.read(true);
        #[cfg(unix)]
        open.custom_flags(libc::O_NONBLOCK);
        let mut handle = open.open(file_path).await?;
        let result: ExecutorResult<_> = async {
            let before_stat = stat_handle(&handle).await?;
            let before = revision_for_file_stat(&before_stat)?;
            if before_stat.revision.size > options.max_bytes as i128 {
                return Err(file_too_large(options.max_bytes).into());
            }
            let bytes = read_content(&mut handle, options.max_bytes).await?;
            after_read().await?;
            let after = revision_for_file_stat(&stat_handle(&handle).await?)?;
            Ok((before == after).then_some(VersionedFile {
                bytes,
                revision: after,
            }))
        }
        .await;
        close_file(handle).await?;
        if let Some(stable) = result? {
            return Ok(stable);
        }
    }
    Err(file_changed_during_read().into())
}

async fn read_content(handle: &mut File, limit: usize) -> ExecutorResult<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let capacity = chunk.len().min((limit - bytes.len()).saturating_add(1));
        let count = handle.read(&mut chunk[..capacity]).await?;
        if count == 0 {
            return Ok(bytes);
        }
        if count > limit - bytes.len() {
            return Err(file_too_large(limit).into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

#[cfg(unix)]
pub(crate) async fn stat_path(path: &str) -> io::Result<FileStat> {
    Ok(file_stat::stat_from_metadata(tokio::fs::metadata(path).await?).into())
}

pub(crate) async fn stat_handle(handle: &File) -> io::Result<FileStat> {
    Ok(file_stat::stat_handle(handle).await?.into())
}

#[cfg(unix)]
pub(crate) async fn close_file(file: File) -> io::Result<()> {
    use std::os::fd::IntoRawFd;
    let file = file.into_std().await;
    tokio::task::spawn_blocking(move || {
        let descriptor = file.into_raw_fd();
        // SAFETY: into_raw_fd transfers ownership and this call consumes it.
        unsafe { rustix::io::try_close(descriptor) }.map_err(io::Error::from)
    })
    .await?
}

#[cfg(windows)]
pub(crate) async fn close_file(file: File) -> io::Result<()> {
    use std::os::windows::io::IntoRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    let file = file.into_std().await;
    tokio::task::spawn_blocking(move || {
        let handle = file.into_raw_handle();
        // SAFETY: into_raw_handle transfers ownership and this call consumes it.
        if unsafe { CloseHandle(handle) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })
    .await?
}

#[cfg(windows)]
pub(crate) async fn stat_path(path: &str) -> io::Result<FileStat> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
    };
    let handle = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .await?;
    stat_handle(&handle).await
}

#[cfg(test)]
mod tests {
    use garcon_base::domain_error::as_domain_error;

    use super::*;

    #[tokio::test]
    async fn stable_files_share_the_read_and_metadata_revision() {
        let fixture = tempfile::tempdir().unwrap();
        let target = fixture.path().join("file");
        let path = target.to_str().unwrap();
        tokio::fs::write(path, b"original").await.unwrap();
        let before = get_file_revision(path).await.unwrap();
        let snapshot = read_versioned_file(path, VersionedReadOptions::default())
            .await
            .unwrap();
        assert_eq!(snapshot.bytes, b"original");
        assert_eq!(snapshot.revision, before);
        let replacement = fixture.path().join("replacement");
        tokio::fs::write(&replacement, b"replaced").await.unwrap();
        tokio::fs::rename(replacement, target).await.unwrap();
        let path = fixture.path().join("file");
        assert_ne!(
            get_file_revision(path.to_str().unwrap()).await.unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn retries_a_changed_read_until_the_returned_bytes_match_the_revision() {
        let fixture = tempfile::tempdir().unwrap();
        let target = fixture.path().join("file");
        let path = target.to_str().unwrap();
        tokio::fs::write(path, b"one").await.unwrap();
        let mut attempts = 0;
        let stable = read_versioned(path, VersionedReadOptions::default(), || {
            attempts += 1;
            let attempt = attempts;
            async move {
                if attempt == 1 {
                    tokio::fs::write(path, b"changed").await?;
                }
                Ok(())
            }
        })
        .await
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(stable.bytes, b"changed");
        assert_eq!(stable.revision, get_file_revision(path).await.unwrap());
    }

    #[tokio::test]
    async fn repeated_instability_and_oversized_files_produce_distinct_errors() {
        let fixture = tempfile::tempdir().unwrap();
        let file = fixture.path().join("file");
        let path = file.to_str().unwrap();
        tokio::fs::write(path, b"one").await.unwrap();
        let mut attempts = 0;
        let error = read_versioned(path, VersionedReadOptions::default(), || {
            attempts += 1;
            let length = attempts + 3;
            async move { tokio::fs::write(path, vec![b'a'; length]).await }
        })
        .await
        .unwrap_err();
        let error = as_domain_error(error.as_ref()).unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(error.code, FILE_CHANGED_DURING_READ);
        assert!(error.retryable);
        let error = read_versioned_file(
            path,
            VersionedReadOptions {
                max_bytes: 3,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            as_domain_error(error.as_ref()).unwrap().code,
            FILE_TOO_LARGE
        );
    }
}
