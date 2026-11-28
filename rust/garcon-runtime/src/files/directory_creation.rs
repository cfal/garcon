//! Ports `server/runtime/files/directory-creation.ts`.

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;
use garcon_interface::resources::ExecutorResult;

pub fn descriptor_paths_directory() -> Option<&'static str> {
    const LINUX_DESCRIPTOR_PATHS: &str = "/proc/self/fd";
    (cfg!(target_os = "linux") && std::path::Path::new(LINUX_DESCRIPTOR_PATHS).exists())
        .then_some(LINUX_DESCRIPTOR_PATHS)
}

pub fn directory_creation_unsupported() -> DomainError {
    DomainError::new(
        ErrorCode::OPERATION_UNSUPPORTED,
        "This executor cannot create directories",
        501,
        false,
    )
}

#[cfg(target_os = "linux")]
pub async fn create_child_directory(
    descriptor_paths: &str,
    parent: &str,
    name: &str,
) -> ExecutorResult<String> {
    create_child(descriptor_paths, parent, name, std::future::ready(())).await
}

#[cfg(target_os = "linux")]
async fn create_child(
    descriptor_paths: &str,
    parent: &str,
    name: &str,
    before_mkdir: impl Future<Output = ()>,
) -> ExecutorResult<String> {
    use std::ffi::OsStr;
    use std::os::fd::AsRawFd;

    use garcon_js::path::native;
    use tokio::fs;

    use super::errors::file_revision_conflict;
    use super::file_revision::close_file;

    let location = descriptor_paths.to_owned();
    if tokio::task::spawn_blocking(move || rustix::fs::access(location, rustix::fs::Access::EXISTS))
        .await?
        .is_err()
    {
        return Err(directory_creation_unsupported().into());
    }
    let mut open = fs::OpenOptions::new();
    open.read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    let handle = open.open(parent).await?;
    let pinned = format!("{descriptor_paths}/{}", handle.as_raw_fd());
    let result: ExecutorResult<_> = async {
        // The open descriptor stays live through mkdir, even if an ancestor moves.
        if fs::read_link(&pinned).await?.as_os_str() != OsStr::new(parent) {
            return Err(file_revision_conflict().into());
        }
        before_mkdir.await;
        fs::create_dir(format!("{pinned}/{name}")).await?;
        Ok(native::join(&[parent, name]))
    }
    .await;
    close_file(handle).await?;
    result
}

#[cfg(not(target_os = "linux"))]
pub async fn create_child_directory(_: &str, _: &str, _: &str) -> ExecutorResult<String> {
    Err(directory_creation_unsupported().into())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::os::unix::fs::symlink;

    use garcon_base::domain_error::as_domain_error;
    use garcon_contract::error_codes::ErrorCode;
    use tokio::fs;

    use super::*;

    #[tokio::test]
    async fn ancestor_replaced_after_pinning_cannot_redirect_creation() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).await.unwrap();
        let initial = root.join("initial");
        let retired = root.join("retired");
        let outside = root.join("outside");
        fs::create_dir_all(initial.join("parent")).await.unwrap();
        fs::create_dir_all(outside.join("parent")).await.unwrap();
        let parent = initial.join("parent");
        create_child(
            descriptor_paths_directory().unwrap(),
            parent.to_str().unwrap(),
            "new",
            async {
                fs::rename(&initial, &retired).await.unwrap();
                symlink(&outside, &initial).unwrap();
            },
        )
        .await
        .unwrap();
        assert!(retired.join("parent/new").is_dir());
        assert!(!outside.join("parent/new").exists());
    }

    #[tokio::test]
    async fn replacement_before_open_cannot_create_in_an_unvalidated_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).await.unwrap();
        let initial = root.join("initial");
        let outside = root.join("outside");
        fs::create_dir_all(outside.join("parent")).await.unwrap();
        symlink(&outside, &initial).unwrap();
        let paths = descriptor_paths_directory().unwrap();
        let error = create_child_directory(paths, initial.join("parent").to_str().unwrap(), "new")
            .await
            .unwrap_err();
        assert_eq!(
            as_domain_error(error.as_ref()).unwrap().code,
            ErrorCode::FILE_REVISION_CONFLICT
        );
        assert!(
            create_child_directory(paths, initial.to_str().unwrap(), "new")
                .await
                .is_err()
        );
        assert!(!outside.join("parent/new").exists());
        assert!(!outside.join("new").exists());
    }
}
