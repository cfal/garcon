//! Native PTY I/O for the executor terminal manager.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use encoding_rs::{Decoder, UTF_8};
use garcon_base::log::{Logger, create_logger};
use garcon_interface::resources::ExecutorResult;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const READ_BYTES: usize = 4096;
const OUTPUT_QUEUE: usize = 16;
const POLL_INTERVAL: Duration = Duration::from_millis(8);

pub(super) struct PtyCommand {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<OsString, OsString>,
    pub name: String,
    pub cols: u16,
    pub rows: u16,
}

pub(super) enum PtyEvent {
    Output(String),
    Exited(u32),
}

#[async_trait(?Send)]
pub(super) trait PtyControl {
    async fn write(&self, data: String) -> ExecutorResult<()>;
    async fn resize(&self, cols: u16, rows: u16) -> ExecutorResult<()>;
    fn kill(&self);
}

pub(super) struct SpawnedPty {
    pub control: Rc<dyn PtyControl>,
    pub events: mpsc::Receiver<PtyEvent>,
}

pub(super) async fn spawn(command: PtyCommand) -> ExecutorResult<SpawnedPty> {
    let (control, events) = tokio::task::spawn_blocking(move || launch(command)).await??;
    Ok(SpawnedPty {
        control: Rc::new(control),
        events,
    })
}

type NativeChild = Box<dyn Child + Send + Sync>;
type Master = Box<dyn MasterPty + Send>;
type Writer = Box<dyn Write + Send>;

struct Handles {
    master: Mutex<Option<Master>>,
    writer: Mutex<Writer>,
    stopped: CancellationToken,
}

struct NativePty {
    handles: Arc<Handles>,
}

impl Drop for NativePty {
    fn drop(&mut self) {
        self.handles.stopped.cancel();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> io::Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| io::Error::other("PTY handle lock poisoned"))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[async_trait(?Send)]
impl PtyControl for NativePty {
    async fn write(&self, data: String) -> ExecutorResult<()> {
        let handles = self.handles.clone();
        tokio::task::spawn_blocking(move || {
            let mut writer = lock(&handles.writer)?;
            let mut remaining = data.as_bytes();
            while !remaining.is_empty() && !handles.stopped.is_cancelled() {
                match writer.write(remaining) {
                    Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                    Ok(n) => remaining = &remaining[n..],
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(POLL_INTERVAL);
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    async fn resize(&self, cols: u16, rows: u16) -> ExecutorResult<()> {
        let handles = self.handles.clone();
        tokio::task::spawn_blocking(move || -> io::Result<()> {
            if let Some(master) = lock(&handles.master)?.as_ref() {
                master.resize(size(cols, rows)).map_err(io::Error::other)?;
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    fn kill(&self) {
        self.handles.stopped.cancel();
    }
}

// A failed thread start must still reap the process it was going to supervise.
struct ReapChild(NativeChild);

impl Drop for ReapChild {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn launch(command: PtyCommand) -> io::Result<(NativePty, mpsc::Receiver<PtyEvent>)> {
    let pair = native_pty_system()
        .openpty(size(command.cols, command.rows))
        .map_err(io::Error::other)?;
    let mut builder = CommandBuilder::new(command.file);
    builder.args(command.args);
    builder.cwd(&command.cwd);
    builder.env_clear();
    for (key, value) in command.env {
        builder.env(key, value);
    }
    if cfg!(unix) {
        builder.env("PWD", &command.cwd);
        builder.env("TERM", &command.name);
    }
    let reader = open_reader(pair.master.as_ref())?;
    let writer = pair.master.take_writer().map_err(io::Error::other)?;
    let child = ReapChild(
        pair.slave
            .spawn_command(builder)
            .map_err(io::Error::other)?,
    );
    drop(pair.slave);
    let handles = Arc::new(Handles {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(writer),
        stopped: CancellationToken::new(),
    });
    let (sender, receiver) = mpsc::channel(OUTPUT_QUEUE);
    start_reader(reader, child, handles.clone(), sender)?;
    Ok((NativePty { handles }, receiver))
}

struct Output {
    sender: mpsc::Sender<PtyEvent>,
    decoder: Decoder,
}

impl Output {
    fn new(sender: mpsc::Sender<PtyEvent>) -> Self {
        Self {
            sender,
            decoder: UTF_8.new_decoder(),
        }
    }

    fn data(&mut self, bytes: &[u8], last: bool) -> bool {
        // A replacement character can use three bytes for every byte received,
        // including the incomplete sequence held across reads.
        let mut text = String::with_capacity(bytes.len() * 3 + 12);
        let _ = self.decoder.decode_to_string(bytes, &mut text, last);
        text.is_empty() || self.sender.blocking_send(PtyEvent::Output(text)).is_ok()
    }

    fn exit(mut self, code: u32) {
        if self.data(&[], true) {
            let _ = self.sender.blocking_send(PtyEvent::Exited(code));
        }
    }
}

fn log_read_error(error: io::Error) {
    create_logger("terminals:manager").warn(&format!("terminal PTY I/O failed: {error}"));
}

#[cfg(unix)]
fn open_reader(master: &dyn MasterPty) -> io::Result<std::fs::File> {
    use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
    use rustix::io::fcntl_dupfd_cloexec;
    use std::os::fd::BorrowedFd;

    let raw = master
        .as_raw_fd()
        .ok_or_else(|| io::Error::other("PTY has no master descriptor"))?;
    // SAFETY: the master owns this descriptor throughout the duplication.
    let reader = fcntl_dupfd_cloexec(unsafe { BorrowedFd::borrow_raw(raw) }, 0)?;
    fcntl_setfl(&reader, fcntl_getfl(&reader)? | OFlags::NONBLOCK)?;
    Ok(reader.into())
}

#[cfg(unix)]
fn start_reader(
    mut reader: std::fs::File,
    mut child: ReapChild,
    handles: Arc<Handles>,
    sender: mpsc::Sender<PtyEvent>,
) -> io::Result<()> {
    std::thread::Builder::new()
        .name("garcon-pty".into())
        .spawn(move || {
            use rustix::event::{PollFd, PollFlags, Timespec, poll};

            let mut output = Output::new(sender);
            let run = || -> io::Result<()> {
                let mut buffer = [0; READ_BYTES];
                let mut read_open = true;
                loop {
                    if handles.stopped.is_cancelled() || output.sender.is_closed() {
                        return Ok(());
                    }
                    let status = child.0.try_wait()?;
                    if read_open {
                        let mut fds = [PollFd::new(&reader, PollFlags::IN)];
                        let wait = Timespec {
                            tv_sec: 0,
                            tv_nsec: if status.is_some() {
                                0
                            } else {
                                POLL_INTERVAL.as_nanos() as i64
                            },
                        };
                        match poll(&mut fds, Some(&wait)) {
                            Ok(0) => {}
                            Ok(_) => match reader.read(&mut buffer) {
                                Ok(0) => read_open = false,
                                Ok(count) => {
                                    if !output.data(&buffer[..count], false) {
                                        return Ok(());
                                    }
                                    continue;
                                }
                                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                                Err(error) if error.raw_os_error() == Some(libc::EIO) => {
                                    read_open = false
                                }
                                Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                                    continue;
                                }
                                Err(error) => return Err(error),
                            },
                            Err(rustix::io::Errno::INTR) => continue,
                            Err(error) => return Err(error.into()),
                        }
                    } else if status.is_none() {
                        std::thread::sleep(POLL_INTERVAL);
                    }
                    if let Some(status) = status {
                        output.exit(status.exit_code());
                        return Ok(());
                    }
                }
            };
            if let Err(error) = run() {
                log_read_error(error);
            }
        })?;
    Ok(())
}

#[cfg(windows)]
fn open_reader(master: &dyn MasterPty) -> io::Result<Box<dyn Read + Send>> {
    master.try_clone_reader().map_err(io::Error::other)
}

#[cfg(windows)]
fn start_reader(
    mut reader: Box<dyn Read + Send>,
    mut child: ReapChild,
    handles: Arc<Handles>,
    sender: mpsc::Sender<PtyEvent>,
) -> io::Result<()> {
    let (done, status) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("garcon-pty-read".into())
        .spawn(move || {
            let mut output = Output::new(sender);
            let mut buffer = [0; READ_BYTES];
            let mut delivering = true;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    // ClosePseudoConsole can wait for its final output to be drained.
                    Ok(count) if delivering => delivering = output.data(&buffer[..count], false),
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::BrokenPipe => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        log_read_error(error);
                        return;
                    }
                }
            }
            if let Ok(Some(code)) = status.recv() {
                output.exit(code);
            }
        })?;
    std::thread::Builder::new()
        .name("garcon-pty-wait".into())
        .spawn(move || {
            let code = loop {
                match child.0.try_wait() {
                    Ok(Some(status)) => break Some(status.exit_code()),
                    Ok(None) if handles.stopped.is_cancelled() => break None,
                    Ok(None) => std::thread::sleep(POLL_INTERVAL),
                    Err(error) => {
                        log_read_error(error);
                        break None;
                    }
                }
            };
            drop(child);
            // Closing ConPTY lets the reader drain and reach EOF, even if the
            // terminal's retained metadata still holds its control handle.
            let master = lock(&handles.master).ok().and_then(|mut slot| slot.take());
            drop(master);
            let _ = done.send(code);
        })?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use tokio::time::timeout;

    use super::*;

    fn shell(file: &str, program: &str) -> PtyCommand {
        PtyCommand {
            file: file.to_owned(),
            args: vec!["-c".to_owned(), program.to_owned()],
            cwd: std::env::current_dir()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned(),
            env: std::env::vars_os().collect(),
            name: "xterm-256color".to_owned(),
            cols: 80,
            rows: 24,
        }
    }

    async fn event(pty: &mut SpawnedPty) -> Option<PtyEvent> {
        timeout(Duration::from_secs(5), pty.events.recv())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn native_shell_echoes_and_resizes_and_drains_utf8_before_exit() {
        let mut pty = spawn(shell(
            "/bin/sh",
            r#"
printf '\357\273\277'
stty size
IFS= read -r input
stty size
printf '%s\n' "$input"
printf '\033[31m\342'
sleep 0.03
printf '\224\200\033[0m\n'
exit 7
"#,
        ))
        .await
        .unwrap();
        let mut text = String::new();
        while !text.contains("24 80\r\n") {
            let Some(PtyEvent::Output(data)) = event(&mut pty).await else {
                panic!("shell exited before accepting input");
            };
            text.push_str(&data);
        }
        pty.control.resize(111, 37).await.unwrap();
        pty.control.write("typed\n".into()).await.unwrap();
        loop {
            match event(&mut pty).await {
                Some(PtyEvent::Output(data)) => text.push_str(&data),
                Some(PtyEvent::Exited(code)) => {
                    assert_eq!(code, 7);
                    break;
                }
                None => panic!("shell closed without an exit status"),
            }
        }
        assert_eq!(
            text,
            "24 80\r\ntyped\r\n37 111\r\ntyped\r\n\x1b[31m\u{2500}\x1b[0m\r\n"
        );
        assert!(event(&mut pty).await.is_none());
    }

    #[tokio::test]
    async fn native_signal_exit_reports_one_and_explicit_kill_closes_delivery() {
        let mut signalled = spawn(shell("/bin/bash", "kill -TERM $$")).await.unwrap();
        assert!(matches!(
            event(&mut signalled).await,
            Some(PtyEvent::Exited(1))
        ));
        assert!(event(&mut signalled).await.is_none());

        let mut killed = spawn(shell("/bin/sh", "exec sleep 60")).await.unwrap();
        killed.control.kill();
        assert!(event(&mut killed).await.is_none());
    }
}
