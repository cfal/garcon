use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs::FileTimes;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use garcon_js::clock::{Clock, SystemClock};
use tokio::{fs, task, time};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::path_boundary::realpath;

pub const WORKSPACE_LOCK_NAME: &str = ".garcon-workspace.lock";

#[derive(Debug, thiserror::Error)]
#[error("Workspace is already in use or could not be locked: {}. {cause}", workspace_dir.display())]
pub struct WorkspaceInUseError {
    pub workspace_dir: PathBuf,
    #[source]
    cause: io::Error,
}

impl WorkspaceInUseError {
    pub const CODE: &'static str = "WORKSPACE_IN_USE";
}

#[derive(Debug, thiserror::Error)]
#[error("Lock file is already being held")]
pub struct LockHeldError;

impl LockHeldError {
    pub const CODE: &'static str = "ELOCKED";
}

#[derive(Debug, thiserror::Error)]
#[error("{cause}")]
pub struct WorkspaceLeaseCompromised {
    #[source]
    pub cause: io::Error,
}

impl WorkspaceLeaseCompromised {
    pub const CODE: &'static str = "ECOMPROMISED";
}

#[derive(Debug, thiserror::Error)]
pub enum AcquireWorkspaceLeaseError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    InUse(#[from] WorkspaceInUseError),
}

#[derive(Debug, thiserror::Error)]
pub enum ReleaseWorkspaceLeaseError {
    #[error("Lock is already released")]
    AlreadyReleased,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Task(#[from] task::JoinError),
}

#[derive(Default)]
pub struct WorkspaceLeaseOptions {
    pub stale_ms: Option<u64>,
    pub update_ms: Option<u64>,
    pub retries: Option<usize>,
    /// Exits the process on a lost lease unless a caller supplies a handler.
    pub on_compromised: Option<Box<dyn FnOnce(WorkspaceLeaseCompromised)>>,
}

pub struct WorkspaceLease {
    pub workspace_dir: PathBuf,
    released: Cell<bool>,
    stop: CancellationToken,
    heartbeat: RefCell<Option<task::JoinHandle<Result<(), ReleaseWorkspaceLeaseError>>>>,
}

impl WorkspaceLease {
    pub async fn release(&self) -> Result<(), ReleaseWorkspaceLeaseError> {
        if self.released.replace(true) {
            return Ok(());
        }
        self.stop.cancel();
        let heartbeat = self.heartbeat.borrow_mut().take();
        if let Some(heartbeat) = heartbeat {
            heartbeat.await??;
        }
        Ok(())
    }
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Acquires and refreshes the lock on the current executor's `LocalSet`.
pub async fn acquire_workspace_lease(
    workspace_dir: impl AsRef<Path>,
    options: WorkspaceLeaseOptions,
) -> Result<WorkspaceLease, AcquireWorkspaceLeaseError> {
    acquire(
        workspace_dir.as_ref(),
        options,
        Rc::new(SystemClock),
        random_fraction,
    )
    .await
}

async fn acquire(
    workspace_dir: &Path,
    options: WorkspaceLeaseOptions,
    clock: Rc<dyn Clock>,
    random: impl FnMut() -> f64,
) -> Result<WorkspaceLease, AcquireWorkspaceLeaseError> {
    fs::create_dir_all(workspace_dir).await?;
    let workspace_dir = realpath(workspace_dir).await?;
    let lock_path = workspace_dir.join(WORKSPACE_LOCK_NAME);
    let stale = options.stale_ms.unwrap_or(30_000).max(2_000);
    let update = options.update_ms.unwrap_or(5_000).clamp(1_000, stale / 2);
    let mut delays = retry_delays(options.retries.unwrap_or(12), random).into_iter();
    let mut errors = HashMap::<String, usize>::new();
    let mut most_frequent: Option<(usize, io::Error)> = None;
    let (mtime, precision) = loop {
        match acquire_lock(&lock_path, stale, clock.as_ref()).await {
            Ok(lock) => break lock,
            Err(cause) => {
                let count = errors.entry(cause.to_string()).or_default();
                *count += 1;
                if most_frequent
                    .as_ref()
                    .is_none_or(|(highest, _)| *count >= *highest)
                {
                    most_frequent = Some((*count, cause));
                }
            }
        }
        let Some(delay) = delays.next() else {
            // INFALLIBLE: Every unsuccessful acquisition records at least one error.
            let (_, cause) = most_frequent.expect("attempted lock acquisition");
            return Err(WorkspaceInUseError {
                workspace_dir,
                cause,
            }
            .into());
        };
        time::sleep(delay).await;
    };
    let stop = CancellationToken::new();
    let heartbeat = task::spawn_local(maintain_lock(Heartbeat {
        path: lock_path,
        stale,
        update,
        mtime,
        precision,
        last_update: clock.now_ms(),
        next_update: time::Instant::now() + Duration::from_millis(update),
        clock,
        stop: stop.clone(),
        on_compromised: options.on_compromised,
    }));
    Ok(WorkspaceLease {
        workspace_dir,
        released: Cell::new(false),
        stop,
        heartbeat: RefCell::new(Some(heartbeat)),
    })
}

fn random_fraction() -> f64 {
    (Uuid::new_v4().as_u128() & ((1 << 53) - 1)) as f64 / ((1_u64 << 53) as f64)
}

fn retry_delays(retries: usize, mut random: impl FnMut() -> f64) -> Vec<Duration> {
    let mut delays: Vec<_> = (0..retries)
        .map(|attempt| {
            let delay = ((1.0 + random()) * 250.0 * 1.5_f64.powf(attempt as f64))
                .round()
                .min(5_000.0);
            Duration::from_millis(delay as u64)
        })
        .collect();
    delays.sort();
    delays
}

#[derive(Debug, Clone, Copy)]
enum MtimePrecision {
    Milliseconds,
    Seconds,
}

impl MtimePrecision {
    fn timestamp(self, now: i64) -> i64 {
        match self {
            Self::Milliseconds => now,
            Self::Seconds => ceil_seconds(now),
        }
    }
}

thread_local! {
    static MTIME_PRECISION: Cell<Option<MtimePrecision>> = const { Cell::new(None) };
}

fn ceil_seconds(ms: i64) -> i64 {
    let remainder = ms.rem_euclid(1_000);
    if remainder == 0 {
        ms
    } else {
        ms.saturating_add(1_000 - remainder)
    }
}

async fn acquire_lock(
    path: &Path,
    stale: u64,
    clock: &dyn Clock,
) -> io::Result<(i64, MtimePrecision)> {
    match fs::create_dir(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            match modified_ms(path).await {
                Ok(mtime) if older_than(mtime, clock.now_ms(), stale) => remove_lock(path).await?,
                Ok(_) => return Err(lock_held()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            match fs::create_dir(path).await {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(lock_held());
                }
                result => result?,
            }
        }
        Err(error) => return Err(error),
    }
    let result = probe_mtime(path, clock).await;
    if result.is_err() {
        let _ = remove_lock(path).await;
    }
    result
}

fn lock_held() -> io::Error {
    io::Error::new(io::ErrorKind::AlreadyExists, LockHeldError)
}

async fn remove_lock(path: &Path) -> io::Result<()> {
    match fs::remove_dir(path).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

async fn modified_ms(path: &Path) -> io::Result<i64> {
    let time = fs::metadata(path).await?.modified()?;
    let millis = |duration: Duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX);
    Ok(time
        .duration_since(UNIX_EPOCH)
        .map_or_else(|error| -millis(error.duration()), millis))
}

async fn set_times(path: &Path, ms: i64) -> io::Result<()> {
    let distance = Duration::from_millis(ms.unsigned_abs());
    let time: SystemTime = if ms < 0 {
        UNIX_EPOCH - distance
    } else {
        UNIX_EPOCH + distance
    };
    let path = path.to_owned();
    task::spawn_blocking(move || {
        std::fs::File::open(path)?.set_times(FileTimes::new().set_accessed(time).set_modified(time))
    })
    .await
    .map_err(io::Error::other)?
}

async fn probe_mtime(path: &Path, clock: &dyn Clock) -> io::Result<(i64, MtimePrecision)> {
    if let Some(precision) = MTIME_PRECISION.get() {
        return modified_ms(path).await.map(|mtime| (mtime, precision));
    }
    set_times(path, ceil_seconds(clock.now_ms()).saturating_add(5)).await?;
    let mtime = modified_ms(path).await?;
    let precision = if mtime % 1_000 == 0 {
        MtimePrecision::Seconds
    } else {
        MtimePrecision::Milliseconds
    };
    MTIME_PRECISION.set(Some(precision));
    Ok((mtime, precision))
}

fn older_than(previous: i64, now: i64, stale: u64) -> bool {
    i128::from(now) - i128::from(previous) > i128::from(stale)
}

struct Heartbeat {
    path: PathBuf,
    stale: u64,
    update: u64,
    mtime: i64,
    precision: MtimePrecision,
    last_update: i64,
    next_update: time::Instant,
    clock: Rc<dyn Clock>,
    stop: CancellationToken,
    on_compromised: Option<Box<dyn FnOnce(WorkspaceLeaseCompromised)>>,
}

async fn maintain_lock(heartbeat: Heartbeat) -> Result<(), ReleaseWorkspaceLeaseError> {
    let Heartbeat {
        path,
        stale,
        update,
        mut mtime,
        precision,
        mut last_update,
        mut next_update,
        clock,
        stop,
        on_compromised,
    } = heartbeat;
    let cause = loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => return Ok(remove_lock(&path).await?),
            () = time::sleep_until(next_update) => {}
        }
        let current = modified_ms(&path).await;
        let result = match current {
            Ok(current) if current == mtime => {
                let fresh = precision.timestamp(clock.now_ms());
                set_times(&path, fresh).await.map(|()| fresh)
            }
            Ok(_) => break io::Error::other("Unable to update lock within the stale threshold"),
            Err(error) => Err(error),
        };
        let delay = match result {
            Ok(new_mtime) => {
                mtime = new_mtime;
                last_update = clock.now_ms();
                update
            }
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || older_than(last_update, clock.now_ms(), stale) =>
            {
                break error;
            }
            Err(_) => 1_000,
        };
        next_update = time::Instant::now() + Duration::from_millis(delay);
    };
    if let Some(on_compromised) = on_compromised {
        on_compromised(WorkspaceLeaseCompromised { cause });
    } else {
        eprintln!("{cause}");
        std::process::exit(1);
    }
    Err(ReleaseWorkspaceLeaseError::AlreadyReleased)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::ManualClock;

    #[tokio::test]
    async fn retries_stale_lock_creation_but_leaves_nonempty_directories_alone() {
        let root = tempfile::tempdir().unwrap();
        let lock = root.path().join(WORKSPACE_LOCK_NAME);
        let clock = ManualClock::new(5_000);
        fs::create_dir(&lock).await.unwrap();
        set_times(&lock, 3_000).await.unwrap();
        let error = acquire_lock(&lock, 2_000, &clock).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        clock.advance(1);
        acquire_lock(&lock, 2_000, &clock).await.unwrap();

        fs::write(lock.join("synthetic"), b"untouched")
            .await
            .unwrap();
        set_times(&lock, 3_000).await.unwrap();
        let error = acquire_lock(&lock, 2_000, &clock).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::DirectoryNotEmpty);
        assert_eq!(
            fs::read(lock.join("synthetic")).await.unwrap(),
            b"untouched"
        );
    }

    #[tokio::test]
    async fn a_changed_mtime_compromises_the_lease_without_removing_it() {
        task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let lock = root.path().join(WORKSPACE_LOCK_NAME);
                let (report, compromised) = tokio::sync::oneshot::channel();
                let lease = acquire_workspace_lease(
                    root.path(),
                    WorkspaceLeaseOptions {
                        retries: Some(0),
                        update_ms: Some(1_000),
                        on_compromised: Some(Box::new(move |error| {
                            report.send(error.to_string()).unwrap()
                        })),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                set_times(&lock, 3_000).await.unwrap();
                assert_eq!(
                    time::timeout(Duration::from_secs(10), compromised)
                        .await
                        .unwrap()
                        .unwrap(),
                    "Unable to update lock within the stale threshold"
                );
                assert!(matches!(
                    lease.release().await,
                    Err(ReleaseWorkspaceLeaseError::AlreadyReleased)
                ));
                assert!(lock.is_dir());
            })
            .await;
    }
}
