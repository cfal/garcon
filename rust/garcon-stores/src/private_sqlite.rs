//! Secures the controller's ticket and review databases and their sidecars.

use std::error::Error;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::time::Duration;

use garcon_base::file_stat::stat_std_handle;
use rusqlite::{Connection, OpenFlags};

type BoxError = Box<dyn Error>;

#[derive(Clone, Copy)]
enum Mode {
    Create,
    Required,
    Optional,
}

fn secure_file(path: &Path, mode: Mode) -> Result<Option<File>, BoxError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = match options.create_new(matches!(mode, Mode::Create)).open(path) {
        Ok(file) => file,
        Err(error) => {
            return match (mode, error.kind()) {
                (Mode::Create, io::ErrorKind::AlreadyExists) => secure_file(path, Mode::Required),
                (Mode::Optional, io::ErrorKind::NotFound) => Ok(None),
                _ => Err(error.into()),
            };
        }
    };
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("SQLite database path is not a regular file.".into());
        }
    }
    if !metadata.is_file() {
        return Err("SQLite database path is not a regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(Some(file))
}

pub fn secure_private_sqlite_sidecars(path: &Path) -> Result<(), BoxError> {
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        secure_file(Path::new(&sidecar), Mode::Optional)?;
    }
    Ok(())
}

pub fn open_private_sqlite_database(
    path: &Path,
    after_open: impl FnOnce() -> Result<(), BoxError>,
) -> Result<Connection, BoxError> {
    let secured_file =
        secure_file(path, Mode::Create)?.ok_or("SQLite database could not be secured.")?;
    let original = stat_std_handle(&secured_file)?.identity;
    secure_private_sqlite_sidecars(path)?;
    let database = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    database.busy_timeout(Duration::ZERO)?;
    after_open()?;
    let opened =
        secure_file(path, Mode::Required)?.ok_or("SQLite database disappeared while opening.")?;
    // SQLite does not expose its handle, so this only checks the pathname's current identity.
    let current = stat_std_handle(&opened)?.identity;
    if (current.dev, current.ino) != (original.dev, original.ino) {
        return Err("SQLite database was replaced while opening.".into());
    }
    Ok(database)
}

pub fn configure_durable_sqlite(database: &Connection) -> Result<(), BoxError> {
    database.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
    let journal =
        database.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))?;
    let foreign_keys = database.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?;
    let synchronous = database.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?;
    if journal != "wal" || foreign_keys != 1 || synchronous != 2 {
        return Err("Unsupported SQLite durability configuration.".into());
    }
    Ok(())
}
