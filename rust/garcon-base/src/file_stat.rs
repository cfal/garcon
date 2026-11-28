//! File identity and nanosecond timestamps from the open handle.

use std::io;

use tokio::fs::File;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub dev: i128,
    pub ino: i128,
    pub size: i128,
    pub mtime_ns: i128,
    pub ctime_ns: i128,
}

pub struct FileStat {
    pub identity: FileIdentity,
    pub is_file: bool,
}

#[cfg(unix)]
pub async fn stat_handle(handle: &File) -> io::Result<FileStat> {
    Ok(stat_from_metadata(handle.metadata().await?))
}

#[cfg(unix)]
pub fn stat_std_handle(handle: &std::fs::File) -> io::Result<FileStat> {
    Ok(stat_from_metadata(handle.metadata()?))
}

#[cfg(unix)]
pub fn stat_from_metadata(metadata: std::fs::Metadata) -> FileStat {
    use std::os::unix::fs::MetadataExt;
    let nanos = |seconds: i64, ns: i64| i128::from(seconds) * 1_000_000_000 + i128::from(ns);
    FileStat {
        identity: FileIdentity {
            dev: metadata.dev().into(),
            ino: metadata.ino().into(),
            size: metadata.size().into(),
            mtime_ns: nanos(metadata.mtime(), metadata.mtime_nsec()),
            ctime_ns: nanos(metadata.ctime(), metadata.ctime_nsec()),
        },
        is_file: metadata.is_file(),
    }
}

#[cfg(windows)]
pub async fn stat_handle(handle: &File) -> io::Result<FileStat> {
    let file = handle.try_clone().await?.into_std().await;
    tokio::task::spawn_blocking(move || stat_std_handle(&file)).await?
}

#[cfg(windows)]
pub fn stat_std_handle(file: &std::fs::File) -> io::Result<FileStat> {
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx,
    };
    let is_file = file.metadata()?.is_file();
    let handle = file.as_raw_handle();
    let mut identity = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    let mut times = MaybeUninit::<FILE_BASIC_INFO>::uninit();
    // SAFETY: both buffers have the documented type and size, and file owns the live handle.
    let (identity, times) = unsafe {
        if GetFileInformationByHandle(handle, identity.as_mut_ptr()) == 0
            || GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                times.as_mut_ptr().cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        (identity.assume_init(), times.assume_init())
    };
    let u64_parts = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    let epoch_ns = |time: i64| (i128::from(time) - 116_444_736_000_000_000) * 100;
    Ok(FileStat {
        identity: FileIdentity {
            dev: identity.dwVolumeSerialNumber.into(),
            ino: u64_parts(identity.nFileIndexHigh, identity.nFileIndexLow).into(),
            size: u64_parts(identity.nFileSizeHigh, identity.nFileSizeLow).into(),
            mtime_ns: epoch_ns(times.LastWriteTime),
            ctime_ns: epoch_ns(times.ChangeTime),
        },
        is_file,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stats_the_open_handle_instead_of_its_replaced_path() {
        let tmp = tempfile::tempdir().unwrap();
        let original = tmp.path().join("original");
        let archived = tmp.path().join("archived");
        tokio::fs::write(&original, b"initial").await.unwrap();
        let handle = File::open(&original).await.unwrap();
        let sync_handle = std::fs::File::open(&original).unwrap();
        let first = stat_handle(&handle).await.unwrap();
        assert!(first.is_file);
        assert_eq!(
            stat_std_handle(&sync_handle).unwrap().identity,
            first.identity
        );
        assert_eq!(first.identity.size, 7);
        tokio::fs::rename(&original, archived).await.unwrap();
        tokio::fs::write(&original, b"replacement").await.unwrap();
        let after = stat_handle(&handle).await.unwrap().identity;
        assert_eq!(stat_std_handle(&sync_handle).unwrap().identity, after);
        let replacement = stat_handle(&File::open(original).await.unwrap())
            .await
            .unwrap()
            .identity;
        assert_eq!(
            (after.dev, after.ino, after.size),
            (first.identity.dev, first.identity.ino, 7)
        );
        assert_ne!((after.dev, after.ino), (replacement.dev, replacement.ino));
        assert_eq!(replacement.size, 11);
    }
}
