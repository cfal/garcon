use std::error::Error;
use std::io;
use std::path::Path;

use garcon_js::clock::{Clock, InvalidTimeValue, SystemClock, to_iso_string};
use garcon_js::json::Opaque;
use garcon_js::path::posix;
use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::log::{Logger, create_logger};
use crate::stored_json::parse_stored_json;

pub const QUARANTINE_INFIX: &str = ".corrupt-";

type BoxError = Box<dyn Error>;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CorruptStateFileError {
    pub file_path: String,
    pub quarantine_path: Option<String>,
    message: String,
    #[source]
    cause: BoxError,
}

impl CorruptStateFileError {
    fn new(file_path: &str, quarantine_path: Option<String>, cause: BoxError) -> Self {
        let basename = posix::basename(file_path);
        let message = if quarantine_path.is_some() {
            format!(
                "State file {basename} is corrupt. Restore a valid state file before starting; keep the quarantine."
            )
        } else {
            format!("State file {basename} is corrupt and could not be quarantined.")
        };
        Self {
            file_path: file_path.into(),
            quarantine_path,
            message,
            cause,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ReadJsonStateError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Corrupt(#[from] CorruptStateFileError),
    #[error(transparent)]
    Clock(#[from] InvalidTimeValue),
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AtomicJsonWriteError {
    pub renamed: bool,
    message: String,
    #[source]
    cause: io::Error,
}

#[derive(Debug, thiserror::Error)]
pub enum WriteFileError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Atomic(#[from] AtomicJsonWriteError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct JsonWriteOptions {
    pub mode: Option<u32>,
    pub trailing_newline: Option<bool>,
}

pub struct JsonFileStore<C = SystemClock, G = fn() -> Uuid> {
    clock: C,
    uuid: G,
}

impl Default for JsonFileStore {
    fn default() -> Self {
        Self::new(SystemClock, Uuid::new_v4)
    }
}

impl<C: Clock, G: Fn() -> Uuid> JsonFileStore<C, G> {
    pub fn new(clock: C, uuid: G) -> Self {
        Self { clock, uuid }
    }

    pub async fn read_json_state_file<T>(
        &self,
        file_path: &str,
        empty: impl FnOnce() -> T,
        normalize: impl FnOnce(Opaque) -> Result<T, BoxError>,
    ) -> Result<T, ReadJsonStateError> {
        let raw = match fs::read(file_path).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if let Some(quarantine) = newest_quarantine_path(file_path).await? {
                    return Err(CorruptStateFileError::new(
                        file_path,
                        Some(quarantine),
                        error.into(),
                    )
                    .into());
                }
                return Ok(empty());
            }
            Err(error) => return Err(error.into()),
        };

        let parsed = parse_stored_json(&String::from_utf8_lossy(&raw), &posix::basename(file_path))
            .map_err(BoxError::from)
            .and_then(normalize);
        match parsed {
            Ok(state) => Ok(state),
            Err(cause) => Err(self.quarantine_state_file(file_path, cause).await),
        }
    }

    async fn quarantine_state_file(&self, file_path: &str, cause: BoxError) -> ReadJsonStateError {
        let logger = create_logger("json-file-store");
        let dir = posix::dirname(file_path);
        let timestamp = match to_iso_string(self.clock.now_ms()) {
            Ok(timestamp) => timestamp.replace(['-', ':', '.'], ""),
            Err(error) => return error.into(),
        };
        let uuid = (self.uuid)().simple().to_string();
        let path = format!("{file_path}{QUARANTINE_INFIX}{timestamp}-{}", &uuid[..8]);
        if let Err(error) = fs::rename(file_path, &path).await {
            if error.kind() == io::ErrorKind::NotFound {
                match newest_quarantine_path(file_path).await {
                    Ok(Some(existing)) => {
                        return CorruptStateFileError::new(file_path, Some(existing), error.into())
                            .into();
                    }
                    Ok(None) => {}
                    Err(lookup) => {
                        logger.error(&format!("State file {file_path} is corrupt and its quarantine could not be located. {lookup}"));
                        return CorruptStateFileError::new(file_path, None, lookup.into()).into();
                    }
                }
            }
            logger.error(&format!(
                "State file {file_path} is corrupt and could not be quarantined. {error}"
            ));
            return CorruptStateFileError::new(file_path, None, error.into()).into();
        }
        if let Err(error) = sync_directory(dir).await {
            logger.error(&format!("State file {file_path} was quarantined to {path}, but the directory sync failed. {error}"));
            return CorruptStateFileError::new(file_path, Some(path), error.into()).into();
        }
        logger.error(&format!("State file {file_path} is corrupt and was quarantined to {path}. Restore a valid state file before starting; keep the quarantine. {cause}"));
        CorruptStateFileError::new(file_path, Some(path), cause).into()
    }

    pub async fn write_json_file_atomic(
        &self,
        file_path: &str,
        value: &(impl Serialize + ?Sized),
        options: JsonWriteOptions,
    ) -> Result<(), WriteFileError> {
        let mut payload = serde_json::to_vec_pretty(value)?;
        if options.trailing_newline != Some(false) {
            payload.push(b'\n');
        }
        self.write_file_atomic(file_path, &payload, options.mode)
            .await
    }

    pub async fn write_file_atomic(
        &self,
        file_path: &str,
        payload: &[u8],
        mode: Option<u32>,
    ) -> Result<(), WriteFileError> {
        let dir = posix::dirname(file_path);
        let base = posix::basename(file_path);
        let temporary_name = format!(".{base}.{}.{}.tmp", std::process::id(), (self.uuid)());
        let temporary_path = posix::join(&[&dir, &temporary_name]);
        fs::create_dir_all(&dir).await?;
        let result = write_candidate(&temporary_path, file_path, &dir, &base, payload, mode).await;
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path).await;
        }
        result
    }
}

async fn newest_quarantine_path(file_path: &str) -> io::Result<Option<String>> {
    let dir = posix::dirname(file_path);
    let prefix = format!("{}{QUARANTINE_INFIX}", posix::basename(file_path));
    let mut entries = match fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut newest: Option<String> = None;
    while let Some(entry) = entries.next_entry().await? {
        let entry = entry.file_name().to_string_lossy().into_owned();
        if entry.starts_with(&prefix)
            && newest
                .as_ref()
                .is_none_or(|prev| prev.encode_utf16().lt(entry.encode_utf16()))
        {
            newest = Some(entry);
        }
    }
    Ok(newest.map(|entry| posix::join(&[&dir, &entry])))
}

async fn write_candidate(
    temporary_path: &str,
    file_path: &str,
    dir: &str,
    base: &str,
    payload: &[u8],
    mode: Option<u32>,
) -> Result<(), WriteFileError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(temporary_path).await?;
    file.write_all(payload).await?;
    file.sync_all().await?;
    drop(file);

    fs::rename(temporary_path, file_path)
        .await
        .map_err(|cause| AtomicJsonWriteError {
            renamed: false,
            message: format!("Atomic write of {base} failed before rename: {cause}"),
            cause,
        })?;
    sync_directory(dir).await.map_err(|cause| AtomicJsonWriteError {
        renamed: true,
        message: format!("Atomic write of {base} renamed the candidate but could not confirm directory durability: {cause}"),
        cause,
    })?;
    Ok(())
}

pub async fn sync_directory(dir: impl AsRef<Path>) -> io::Result<()> {
    let result = async {
        let directory = fs::File::open(dir).await?;
        directory.sync_all().await
    }
    .await;
    match result {
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EISDIR | libc::EINVAL | libc::EPERM | libc::ENOTSUP)
            ) =>
        {
            Ok(())
        }
        result => result,
    }
}
