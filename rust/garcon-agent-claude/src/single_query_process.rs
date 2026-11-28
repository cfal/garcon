use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use futures::future::FutureExt;
use garcon_base::errors::NamedError;
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::{
    cli_environment::build_claude_cli_environment,
    cli_process_transport::{
        ClaudeExitStatus, ClaudeProcessOptions, ClaudeProcessSignal, KillProcess, ProcessOutput,
        spawn_claude_subprocess_with_stdin, wait_for_exit,
    },
};

pub const MAX_SINGLE_QUERY_STDOUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SINGLE_QUERY_STDERR_BYTES: usize = 16 * 1024;
const SINGLE_QUERY_EXIT_GRACE: Duration = Duration::from_secs(1);

pub struct ClaudeSingleQueryProcessOptions<'a> {
    pub binary: OsString,
    pub args: Vec<OsString>,
    pub model: Option<&'a str>,
    pub cwd: PathBuf,
    pub env_overrides: IndexMap<OsString, OsString>,
    pub signal: &'a CancellationToken,
    pub logger: &'a dyn AgentLogger,
}

pub async fn run_claude_single_query_process(
    options: ClaudeSingleQueryProcessOptions<'_>,
) -> ExecutorResult<String> {
    let environment = build_claude_cli_environment(
        options.model.unwrap_or_default(),
        std::env::vars_os(),
        options.env_overrides,
    )?;
    check_aborted(options.signal)?;
    let process = spawn_claude_subprocess_with_stdin(
        ClaudeProcessOptions {
            executable: options.binary,
            arguments: options.args,
            cwd: options.cwd,
            environment,
        },
        Stdio::null(),
    )?;
    let exited = process.exited.shared();
    let mut killed = false;
    let result = {
        let status = exited.clone();
        let output = async move {
            tokio::try_join!(
                read_bounded_output(process.stdout, MAX_SINGLE_QUERY_STDOUT_BYTES, "stdout"),
                read_bounded_output(process.stderr, MAX_SINGLE_QUERY_STDERR_BYTES, "stderr"),
                async {
                    status
                        .await
                        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })
                },
            )
        };
        tokio::pin!(output);
        tokio::select! {
            biased;
            result = &mut output => result,
            () = options.signal.cancelled() => {
                (process.kill)(ClaudeProcessSignal::Term)?;
                killed = true;
                output.await
            }
        }
    };
    let (stdout, stderr, exit_code) = match result {
        Ok(output) => output,
        Err(error) => {
            if let Err(teardown) =
                terminate_failed_process(exited, process.kill.as_ref(), killed).await
            {
                return Err(SingleQueryTeardownError {
                    source: error,
                    teardown: teardown.to_string(),
                }
                .into());
            }
            return Err(error);
        }
    };
    check_aborted(options.signal)?;
    if exit_code != 0 {
        let stderr_bytes = stderr.len();
        let digest = (!stderr.is_empty()).then(|| {
            let digest = Sha256::digest(stderr.as_bytes());
            digest[..8]
                .iter()
                .fold(String::with_capacity(16), |mut hex, byte| {
                    use std::fmt::Write;
                    let _ = write!(hex, "{byte:02x}");
                    hex
                })
        });
        let fields = IndexMap::from([
            ("exitCode".to_owned(), Opaque::from_value(json!(exit_code))),
            (
                "stderrBytes".to_owned(),
                Opaque::from_value(json!(stderr_bytes)),
            ),
            ("stderrDigest".to_owned(), Opaque::from_value(json!(digest))),
        ]);
        options
            .logger
            .warn("Claude one-shot process failed", Some(&fields));
        let message = match digest {
            Some(digest) => {
                format!("Claude CLI exited with code {exit_code} (stderr digest {digest})")
            }
            None => format!("Claude CLI exited with code {exit_code}"),
        };
        return Err(message.into());
    }
    Ok(stdout)
}

#[derive(Debug, thiserror::Error)]
#[error("{source} Claude one-shot teardown failed: {teardown}")]
struct SingleQueryTeardownError {
    #[source]
    source: Box<dyn std::error::Error>,
    teardown: String,
}

fn check_aborted(signal: &CancellationToken) -> ExecutorResult<()> {
    if !signal.is_cancelled() {
        return Ok(());
    }
    Err(NamedError {
        name: "AbortError".to_owned(),
        message: "The operation was aborted.".to_owned(),
        code: None,
    }
    .into())
}

async fn terminate_failed_process(
    exit: ClaudeExitStatus,
    kill: &KillProcess,
    killed: bool,
) -> ExecutorResult<()> {
    if wait_for_exit(exit.clone(), Duration::ZERO).await {
        return Ok(());
    }
    if !killed {
        kill(ClaudeProcessSignal::Term)?;
    }
    if wait_for_exit(exit.clone(), SINGLE_QUERY_EXIT_GRACE).await {
        return Ok(());
    }
    kill(ClaudeProcessSignal::Kill)?;
    if wait_for_exit(exit, SINGLE_QUERY_EXIT_GRACE).await {
        return Ok(());
    }
    Err("Claude one-shot process did not exit after SIGKILL".into())
}

async fn read_bounded_output(
    stream: Option<ProcessOutput>,
    max_bytes: usize,
    name: &'static str,
) -> ExecutorResult<String> {
    let Some(mut stream) = stream else {
        return Ok(String::new());
    };
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        if output.len() + read > max_bytes {
            return Err(format!("Claude one-shot {name} exceeded {max_bytes} bytes").into());
        }
        output.extend_from_slice(&buffer[..read]);
    }
    let text = String::from_utf8_lossy(&output);
    Ok(text
        .strip_prefix('\u{feff}')
        .unwrap_or(text.as_ref())
        .to_owned())
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, path::Path};

    use super::*;

    #[derive(Default)]
    struct Logger(RefCell<Vec<(String, IndexMap<String, Opaque>)>>);
    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, text: &str, fields: Option<&IndexMap<String, Opaque>>) {
            self.0
                .borrow_mut()
                .push((text.to_owned(), fields.cloned().unwrap_or_default()));
        }
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    fn fixture<'a>(
        cwd: &Path,
        script: &str,
        signal: &'a CancellationToken,
        logger: &'a Logger,
    ) -> ClaudeSingleQueryProcessOptions<'a> {
        ClaudeSingleQueryProcessOptions {
            binary: "bun".into(),
            args: vec!["-e".into(), script.into()],
            cwd: cwd.to_owned(),
            model: None,
            env_overrides: IndexMap::new(),
            signal,
            logger,
        }
    }

    #[tokio::test]
    async fn returns_stdout_and_keeps_stderr_private_on_nonzero_exit() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let log = Logger::default();
        let ran = run_claude_single_query_process(fixture(
            root.path(),
            "process.stdout.write('synthetic');",
            &token,
            &log,
        ))
        .await
        .unwrap();
        assert_eq!(ran, "synthetic");
        let failed = run_claude_single_query_process(fixture(
            root.path(),
            "process.stderr.write('synthetic-private', () => process.exit(7));",
            &token,
            &log,
        ))
        .await
        .unwrap_err();
        assert!(
            failed
                .to_string()
                .starts_with("Claude CLI exited with code 7 (stderr digest ")
        );
        assert!(!failed.to_string().contains("synthetic-private"));
        let warned = log.0.borrow();
        assert_eq!(warned.len(), 1);
        assert_eq!(warned[0].1["stderrBytes"].as_value().as_f64(), Some(17.0));
        assert!(
            !serde_json::to_string(&warned[0].1)
                .unwrap()
                .contains("synthetic-private")
        );
    }

    #[tokio::test]
    async fn rejects_stdout_and_stderr_overflows_without_waiting_on_the_other_pipe() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let log = Logger::default();
        for (pipe, cap) in [
            ("stdout", MAX_SINGLE_QUERY_STDOUT_BYTES),
            ("stderr", MAX_SINGLE_QUERY_STDERR_BYTES),
        ] {
            let script = format!(
                "setInterval(() => {{}}, 60_000); process.{pipe}.write('x'.repeat({}));",
                cap + 1
            );
            let result = tokio::time::timeout(
                Duration::from_secs(8),
                run_claude_single_query_process(fixture(root.path(), &script, &token, &log)),
            )
            .await
            .unwrap();
            assert_eq!(
                result.unwrap_err().to_string(),
                format!("Claude one-shot {pipe} exceeded {cap} bytes")
            );
        }
    }

    #[tokio::test]
    async fn an_already_cancelled_query_never_spawns_its_binary() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        token.cancel();
        let log = Logger::default();
        let mut options = fixture(root.path(), "unknown", &token, &log);
        options.binary = root.path().join("does-not-exist").into_os_string();
        let error = run_claude_single_query_process(options).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<NamedError>().unwrap().name,
            "AbortError"
        );
    }
}
