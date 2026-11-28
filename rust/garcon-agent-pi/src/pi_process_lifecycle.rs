//! Ports `server-agents/pi/src/agents/pi/pi-process-lifecycle.ts`.

use std::cell::Cell;
use std::io;
use std::process::ExitStatus;
use std::rc::Rc;
use std::time::Duration;

use garcon_interface::resources::ExecutorResult;
use tokio::process::Child;
use tokio::sync::watch;

const PROCESS_EXIT_TERM_MS: u64 = 5_000;
const PROCESS_EXIT_KILL_MS: u64 = 5_000;

#[derive(Clone)]
pub struct PiProcess {
    #[cfg(unix)]
    pid: Option<u32>,
    #[cfg(windows)]
    kill_requests: tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<io::Result<()>>>,
    exited: watch::Receiver<Option<i32>>,
    killed: Rc<Cell<bool>>,
}

impl PiProcess {
    pub fn supervise(mut child: Child) -> Self {
        #[cfg(unix)]
        let pid = child.id();
        let (exit, exited) = watch::channel(None);
        #[cfg(windows)]
        let (kill_requests, mut requests) =
            tokio::sync::mpsc::unbounded_channel::<tokio::sync::oneshot::Sender<io::Result<()>>>();
        tokio::task::spawn_local(async move {
            #[cfg(unix)]
            let status = child.wait().await;
            #[cfg(windows)]
            let status = loop {
                tokio::select! {
                    status = child.wait() => break status,
                    request = requests.recv() => {
                        let Some(request) = request else { break child.wait().await; };
                        let _ = request.send(child.start_kill());
                    }
                }
            };
            if let Ok(status) = status {
                exit.send_replace(Some(exit_code(status)));
            }
        });
        Self {
            #[cfg(unix)]
            pid,
            #[cfg(windows)]
            kill_requests,
            exited,
            killed: Rc::new(Cell::new(false)),
        }
    }

    pub fn exit_receiver(&self) -> watch::Receiver<Option<i32>> {
        self.exited.clone()
    }

    pub fn killed_flag(&self) -> Rc<Cell<bool>> {
        self.killed.clone()
    }

    async fn kill(&self, force: bool) -> io::Result<()> {
        self.killed.set(true);
        if self.exited.borrow().is_some() {
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            use nix::sys::signal::{Signal, kill};
            use nix::unistd::Pid;
            let signal = if force {
                Signal::SIGKILL
            } else {
                Signal::SIGTERM
            };
            kill(Pid::from_raw(pid as i32), signal).map_err(io::Error::from)?;
        }
        #[cfg(windows)]
        {
            let _ = force;
            let (response, result) = tokio::sync::oneshot::channel();
            if self.kill_requests.send(response).is_ok() {
                if let Ok(result) = result.await {
                    result?;
                }
            }
        }
        Ok(())
    }
}

pub async fn terminate_pi_process(process: &PiProcess) -> ExecutorResult<()> {
    if !process.killed.get() {
        process.kill(false).await?;
    }
    if wait_for_exit(process.exit_receiver(), PROCESS_EXIT_TERM_MS).await {
        return Ok(());
    }
    process.kill(true).await?;
    if !wait_for_exit(process.exit_receiver(), PROCESS_EXIT_KILL_MS).await {
        return Err("Pi process did not exit after SIGKILL".into());
    }
    Ok(())
}

async fn wait_for_exit(mut exited: watch::Receiver<Option<i32>>, timeout_ms: u64) -> bool {
    // Failure to observe exit also ends the wait, like a rejected exited promise.
    tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        exited.wait_for(|code| code.is_some()),
    )
    .await
    .is_ok()
}

pub fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}
