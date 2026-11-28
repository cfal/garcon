use std::{fs, io, path::Path};

use garcon_base::errors::{ErrorInput, has_node_error_code};

pub fn stat_size_if_exists(path: impl AsRef<Path>) -> io::Result<Option<u64>> {
    optional_stat(fs::metadata(path)).map(|metadata| metadata.map(|metadata| metadata.len()))
}

pub fn lstat_if_exists(path: impl AsRef<Path>) -> io::Result<Option<fs::Metadata>> {
    optional_stat(fs::symlink_metadata(path))
}

fn optional_stat(result: io::Result<fs::Metadata>) -> io::Result<Option<fs::Metadata>> {
    match result {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if has_node_error_code(ErrorInput::Error(&error), "ENOENT") => Ok(None),
        Err(error) => Err(error),
    }
}
