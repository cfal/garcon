//! Runs the TypeScript controller as the front door's fallback. The original
//! listens on an ephemeral loopback port and owns all state; the front door
//! relays its logs and mirrors its lifetime.

use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

const READY_MARKER: &str = "Started at ";

type ReadySignal = Arc<Mutex<Option<oneshot::Sender<String>>>>;

/// The command that starts the original. `GARCON_RS_BUN` overrides the Bun
/// executable found on `PATH`.
fn original_command(root: &Path) -> Command {
    let bun = std::env::var("GARCON_RS_BUN").unwrap_or_else(|_| "bun".to_string());
    let mut command = Command::new(bun);
    command.arg(root.join("server").join("main.ts"));
    command
}

/// Runs the original in the foreground with inherited stdio, for modes the
/// front door does not serve.
pub async fn run_in_foreground(root: &Path, args: &[String]) -> std::io::Result<ExitStatus> {
    original_command(root).args(args).status().await
}

pub struct OriginalServer {
    pub child: Child,
    /// The original's own origin, such as `http://127.0.0.1:41234`.
    pub origin: String,
}

struct ReadyLine<'a> {
    prefix: &'a str,
    origin: &'a str,
    suffix: &'a str,
}

/// Splits the original's readiness line around its origin; the suffix is the
/// base path when one is configured.
fn parse_ready_line(line: &str) -> Option<ReadyLine<'_>> {
    let start = line.find(READY_MARKER)? + READY_MARKER.len();
    let url = &line[start..];
    let authority = url.strip_prefix("http://")?;
    let origin_end = "http://".len() + authority.find('/').unwrap_or(authority.len());
    Some(ReadyLine {
        prefix: &line[..start],
        origin: &url[..origin_end],
        suffix: &url[origin_end..],
    })
}

/// Relays one output stream line by line. The readiness line is rewritten to
/// announce the front door's URL instead of the original's loopback port, so
/// tools that wait for it connect to the front door.
async fn relay_lines<R, W>(stream: R, mut sink: W, public_url: String, ready: ReadySignal)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let pending = ready.lock().expect("ready signal lock").take();
        let output = match (pending, parse_ready_line(&line)) {
            (Some(sender), Some(parsed)) => {
                let _ = sender.send(parsed.origin.to_string());
                format!("{}{public_url}{}", parsed.prefix, parsed.suffix)
            }
            (pending, _) => {
                *ready.lock().expect("ready signal lock") = pending;
                line
            }
        };
        if sink
            .write_all(format!("{output}\n").as_bytes())
            .await
            .is_err()
        {
            break;
        }
        let _ = sink.flush().await;
    }
}

pub async fn start(
    root: &Path,
    args: &[String],
    trust_proxy: bool,
    public_url: String,
    runtime_origin: &str,
) -> std::io::Result<OriginalServer> {
    let mut command = original_command(root);
    command
        .args(args)
        .args(["--port", "0", "--bind-address", "127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "linux")]
    {
        // The original dies with the front door even when the front door is
        // killed abruptly, so it never outlives it holding the workspace lease.
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: the closure runs in the forked child before exec and only
        // makes async-signal-safe calls.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                    || libc::getppid() != parent
                {
                    return Err(std::io::Error::other(
                        "the front door exited before the original started",
                    ));
                }
                Ok(())
            });
        }
    }
    // The front door replaces the forwarded client address headers (see
    // proxy.rs), so the original may trust them; otherwise every client would
    // share the front door's loopback address in the login rate limiter.
    if !trust_proxy {
        command.env("GARCON_TRUST_PROXY", "1");
    }
    // CLI discovery must reach the front door, whose address survives a restart
    // of the original; the original's own port is ephemeral.
    command.env("GARCON_RUNTIME_ORIGIN", runtime_origin);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let (ready_tx, ready_rx) = oneshot::channel();
    let ready: ReadySignal = Arc::new(Mutex::new(Some(ready_tx)));
    tokio::spawn(relay_lines(
        stdout,
        tokio::io::stdout(),
        public_url.clone(),
        ready.clone(),
    ));
    tokio::spawn(relay_lines(stderr, tokio::io::stderr(), public_url, ready));

    let origin = tokio::select! {
        Ok(origin) = ready_rx => origin,
        status = child.wait() => {
            let status = status?;
            return Err(std::io::Error::other(format!("the original exited before it was ready ({status})")));
        }
    };
    Ok(OriginalServer { child, origin })
}

/// Asks the original to shut down gracefully, so it flushes delayed writes and
/// releases its workspace lease, then waits for it.
pub async fn stop(child: &mut Child) -> std::io::Result<ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: `kill` has no memory-safety preconditions; the pid belongs
        // to a child this process has not yet reaped.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    child.start_kill()?;
    child.wait().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_origin_from_the_readiness_line() {
        let parsed =
            parse_ready_line("[INFO] Started at http://127.0.0.1:4321/tools/garcon").unwrap();
        assert_eq!(
            (parsed.prefix, parsed.origin, parsed.suffix),
            (
                "[INFO] Started at ",
                "http://127.0.0.1:4321",
                "/tools/garcon"
            )
        );
        assert_eq!(
            parse_ready_line("Started at http://[::1]:80")
                .unwrap()
                .origin,
            "http://[::1]:80"
        );
        assert!(parse_ready_line("Authentication: ENABLED").is_none());
    }

    #[tokio::test]
    async fn rewrites_only_the_first_readiness_line() {
        let input = b"boot\n[INFO] Started at http://127.0.0.1:4321/base\nStarted at http://x:1\n";
        let mut output = Vec::new();
        let (sender, receiver) = oneshot::channel();
        let ready = Arc::new(Mutex::new(Some(sender)));
        relay_lines(
            &input[..],
            &mut output,
            "http://0.0.0.0:8080".to_string(),
            ready,
        )
        .await;
        assert_eq!(receiver.await.unwrap(), "http://127.0.0.1:4321");
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "boot\n[INFO] Started at http://0.0.0.0:8080/base\nStarted at http://x:1\n"
        );
    }
}
