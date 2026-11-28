use std::{io, process::Stdio, sync::LazyLock, time::Duration};

use garcon_js::js::trim;
use regress::Regex;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use super::installer_environment::Environment;

const KILL_GRACE: Duration = Duration::from_secs(1);
const MAX_PARTIAL_LINE_CHARS: usize = 4_096;

static REDRAW: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The fixed redraw expression is valid.
    Regex::new(r"\x1b\[(?:0*1?G|999D)").expect("redraw pattern")
});

static VT_CONTROL: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The fixed Node stripVTControlCharacters expression is valid.
    Regex::new(r"[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?(?:\u0007|\u001B\\))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))").expect("VT control pattern")
});

pub struct BoundedCommandOptions<'a> {
    pub env: &'a Environment,
    pub timeout: Duration,
    pub max_output_bytes: usize,
    pub on_line: Option<&'a dyn Fn(&str)>,
}

#[derive(Debug)]
pub struct BoundedCommandResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

pub async fn run_bounded_command(
    executable: &str,
    args: &[String],
    options: BoundedCommandOptions<'_>,
) -> io::Result<BoundedCommandResult> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_clear()
        .envs(options.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    // SAFETY: setsid only invokes the OS to create the child's session.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("Child did not report a process ID"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing child stdout pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing child stderr pipe"))?;
    let completion = async {
        tokio::try_join!(
            collect(stdout, options.max_output_bytes, options.on_line),
            collect(stderr, options.max_output_bytes, options.on_line),
            child.wait(),
        )
    };
    tokio::pin!(completion);
    let mut timed_out = false;
    let (stdout, stderr, status) = tokio::select! {
        biased;
        result = &mut completion => result?,
        () = tokio::time::sleep(options.timeout) => {
            timed_out = true;
            terminate_tree(pid, options.env)?;
            tokio::select! {
                biased;
                result = &mut completion => result?,
                () = tokio::time::sleep(KILL_GRACE) => {
                    kill_group(pid);
                    completion.await?
                }
            }
        }
    };
    Ok(BoundedCommandResult {
        exit_code: if timed_out { None } else { exit_code(status) },
        stdout: stdout.text,
        stderr: stderr.text,
        timed_out,
        truncated: stdout.truncated || stderr.truncated,
    })
}

fn exit_code(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
    }
    #[cfg(not(unix))]
    status.code()
}

fn terminate_tree(pid: u32, _env: &Environment) -> io::Result<()> {
    #[cfg(unix)]
    signal_group(pid, libc::SIGTERM);
    #[cfg(windows)]
    {
        let mut killer = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .env_clear()
            .envs(_env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        tokio::spawn(async move {
            let _ = killer.wait().await;
        });
    }
    Ok(())
}

fn kill_group(_pid: u32) {
    #[cfg(unix)]
    signal_group(_pid, libc::SIGKILL);
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    if let Ok(pid) = libc::pid_t::try_from(pid) {
        // SAFETY: This positive ID belongs to the spawned session leader.
        unsafe { libc::kill(-pid, signal) };
    }
}

struct Captured {
    text: String,
    truncated: bool,
}

async fn collect(
    mut stream: impl AsyncRead + Unpin,
    max_bytes: usize,
    on_line: Option<&dyn Fn(&str)>,
) -> io::Result<Captured> {
    let mut tail = Vec::new();
    let mut truncated = false;
    let mut partial = String::new();
    let mut undecoded = Vec::new();
    let mut leading = true;
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        let excess = (tail.len() + count).saturating_sub(max_bytes);
        let dropped = excess.min(tail.len());
        if excess > 0 {
            truncated = true;
            tail.drain(..dropped);
        }
        tail.extend_from_slice(&chunk[excess - dropped..]);
        if let Some(on_line) = on_line {
            undecoded.extend_from_slice(chunk);
            decode_chunk(&mut undecoded, &mut partial, &mut leading);
            partial = replace_redraw(&partial);
            if let Some(end) = partial.rfind(['\n', '\r']) {
                for line in output_lines(&partial[..=end]) {
                    on_line(&line);
                }
                partial.drain(..=end);
            }
            partial = tail_utf16(&partial, MAX_PARTIAL_LINE_CHARS);
        }
    }
    if let Some(on_line) = on_line {
        partial.push_str(&String::from_utf8_lossy(&undecoded));
        for line in output_lines(&partial) {
            on_line(&line);
        }
    }
    Ok(Captured {
        text: String::from_utf8_lossy(&tail).into_owned(),
        truncated,
    })
}

fn decode_chunk(bytes: &mut Vec<u8>, text: &mut String, leading: &mut bool) {
    let mut consumed = 0;
    while consumed < bytes.len() {
        let remaining = &bytes[consumed..];
        match std::str::from_utf8(remaining) {
            Ok(s) => {
                append_decoded(text, s, leading);
                consumed = bytes.len();
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if let Ok(prefix) = std::str::from_utf8(&remaining[..valid]) {
                    append_decoded(text, prefix, leading);
                }
                consumed += valid;
                let Some(invalid) = error.error_len() else {
                    break;
                };
                consumed += invalid;
                append_decoded(text, "\u{fffd}", leading);
            }
        }
    }
    bytes.drain(..consumed);
}

fn append_decoded(text: &mut String, decoded: &str, leading: &mut bool) {
    if *leading && !decoded.is_empty() {
        *leading = false;
        text.push_str(decoded.strip_prefix('\u{feff}').unwrap_or(decoded));
    } else {
        text.push_str(decoded);
    }
}

pub(super) fn tail_utf16(text: &str, max_chars: usize) -> String {
    let units: Vec<_> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[units.len().saturating_sub(max_chars)..])
}

fn replace_matches(text: &str, pattern: &Regex, replacement: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut start = 0;
    for m in pattern.find_iter(text) {
        result.push_str(&text[start..m.start()]);
        result.push_str(replacement);
        start = m.end();
    }
    result.push_str(&text[start..]);
    result
}

fn replace_redraw(text: &str) -> String {
    replace_matches(text, &REDRAW, "\r")
}

pub fn output_lines(text: &str) -> Vec<String> {
    replace_redraw(text)
        .split(['\r', '\n'])
        .filter_map(|line| {
            let stripped = replace_matches(line, &VT_CONTROL, "");
            let line = stripped
                .split(|ch: char| trim(ch.encode_utf8(&mut [0; 4])).is_empty())
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            (!line.is_empty()).then_some(line)
        })
        .collect()
}
