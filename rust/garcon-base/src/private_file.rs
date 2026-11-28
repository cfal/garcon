use std::io;
use std::path::Path;

pub async fn assert_private_file(file_path: impl AsRef<Path>) -> io::Result<()> {
    match tokio::fs::metadata(file_path).await {
        Ok(_details) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if _details.permissions().mode() & 0o077 != 0 {
                    return Err(io::Error::other(
                        "Credential file must be accessible only to its OS account",
                    ));
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn permits_a_missing_file_or_a_file_with_only_owner_permissions() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("credential");
        assert_private_file(&file).await.unwrap();
        tokio::fs::write(&file, "synthetic").await.unwrap();
        tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))
            .await
            .unwrap();
        assert_private_file(&file).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_permissions_for_other_accounts_and_follows_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("credential");
        tokio::fs::write(&file, "synthetic").await.unwrap();
        tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640))
            .await
            .unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(file, &link).unwrap();
        assert_eq!(
            assert_private_file(link).await.unwrap_err().to_string(),
            "Credential file must be accessible only to its OS account"
        );
    }
}
