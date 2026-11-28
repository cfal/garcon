use std::{error::Error, fs, io};

use garcon_base::errors::{ErrorInput, has_node_error_code};
use garcon_js::path::native;

pub fn ensure_ledger_root_directory(root_directory: &str) -> io::Result<String> {
    private_directory_builder()
        .recursive(true)
        .create(root_directory)?;
    realpath(root_directory)
}

pub fn ensure_ledger_chat_directory(
    root_directory: &str,
    chat_id: &str,
) -> Result<String, Box<dyn Error>> {
    if ensure_ledger_root_directory(root_directory)? != root_directory {
        return Err(
            io::Error::other(format!("Transcript ledger root changed: {root_directory}")).into(),
        );
    }
    let directory = native::join(&[root_directory, chat_id]);
    if let Err(error) = private_directory_builder().create(&directory)
        && !has_node_error_code(ErrorInput::Error(&error), "EEXIST")
    {
        return Err(error.into());
    }
    let stats = fs::symlink_metadata(&directory)?;
    if !stats.is_dir() || stats.is_symlink() {
        return Err(io::Error::other(format!(
            "Transcript ledger path is not a directory: {directory}"
        ))
        .into());
    }
    let canonical = realpath(&directory)?;
    if native::dirname(&canonical) != root_directory {
        return Err(io::Error::other(format!(
            "Transcript ledger path escapes its root: {directory}"
        ))
        .into());
    }
    chmod(&canonical, 0o700)?;
    Ok(canonical)
}

pub(crate) fn private_directory_builder() -> fs::DirBuilder {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;

        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
}

fn realpath(path: &str) -> io::Result<String> {
    #[cfg(target_os = "linux")]
    if path.contains('\\') {
        // Bun 1.4.3 rejects backslashes in realpath input on Linux.
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("ENOENT: no such file or directory, lstat '{path}'"),
        ));
    }
    let path = fs::canonicalize(path)?;
    let canonical = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        if let Some(disk) = canonical
            .strip_prefix(r"\\?\")
            .filter(|tail| tail.as_bytes().get(1) == Some(&b':'))
        {
            return Ok(disk.into());
        }
    }
    Ok(canonical.into_owned())
}

pub(crate) fn chmod(path: &str, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        // Node ignores the group and other bits on Windows.
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(path, permissions)
    }
}
