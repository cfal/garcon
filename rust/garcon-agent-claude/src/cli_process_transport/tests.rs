use std::task::{Context, Poll};

use tokio::{sync::mpsc::UnboundedReceiver, task::LocalSet};

use super::*;

#[derive(Default)]
struct Logger {
    warnings: RefCell<Vec<String>>,
}

impl AgentLogger for Logger {
    fn debug(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, message: &str, _fields: Option<&IndexMap<String, Opaque>>) {
        self.warnings.borrow_mut().push(message.to_owned());
    }
    fn error(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
}

struct Events {
    messages: UnboundedReceiver<Opaque>,
    failures: UnboundedReceiver<ClaudeTransportFailure>,
    eof: UnboundedReceiver<()>,
    exits: UnboundedReceiver<ClaudeProcessExit>,
}

fn transport(
    process: ClaudeSubprocess,
    logger: Rc<Logger>,
    max_frame: Option<usize>,
) -> (ClaudeProcessTransport, Events) {
    let (message, messages) = mpsc::unbounded_channel();
    let (failure, failures) = mpsc::unbounded_channel();
    let (on_eof, eof) = mpsc::unbounded_channel();
    let (exit, exits) = mpsc::unbounded_channel();
    let transport = ClaudeProcessTransport::new(ClaudeProcessTransportOptions {
        process,
        logger,
        session_id: "synthetic-session".to_owned(),
        on_message: Rc::new(move |value| {
            let _ = message.send(value);
        }),
        on_failure: Rc::new(move |value| {
            let _ = failure.send(value);
        }),
        on_eof: Rc::new(move || {
            let _ = on_eof.send(());
        }),
        on_exit: Rc::new(move |value| {
            let _ = exit.send(value);
        }),
        max_stdout_frame_bytes: max_frame,
    });
    (
        transport,
        Events {
            messages,
            failures,
            eof,
            exits,
        },
    )
}

#[tokio::test]
async fn drains_real_cli_pipes_and_preserves_ordered_json_lines_and_redacted_stderr() {
    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let child = spawn_claude_subprocess(ClaudeProcessOptions {
            executable: "bun".into(), arguments: vec!["-e".into(), r#"
                const { createInterface } = require('node:readline');
                process.stdout.write('startup noise\n');
                let completed = 0;
                createInterface({ input: process.stdin }).on('line', (line) => {
                    const result = JSON.stringify(JSON.parse(line));
                    process.stdout.write(result.slice(0, 3));
                    process.stdout.write(result.slice(3) + '\n');
                    if (++completed === 3) {
                        process.stderr.write('synthetic-private\n' + 'x'.repeat(17000), () => process.exit(7));
                    }
                });
            "#.into()],
            cwd: directory.path().to_owned(), environment: std::env::vars_os().collect(),
        }).unwrap();
        let log = Rc::new(Logger::default());
        let (transport, mut events) = transport(child, log.clone(), None);
        let writes = (1..=3).map(|seq| transport.write_line(format!("{{\"order\":{seq}}}"), Default::default())).collect::<Vec<_>>();
        futures::future::try_join_all(writes).await.unwrap();
        for seq in 1..=3 {
            let arrived = tokio::time::timeout(Duration::from_secs(5), events.messages.recv()).await.unwrap().unwrap();
                assert_eq!(serde_json::to_string(&arrived).unwrap(), format!("{{\"order\":{seq}}}"));
        }
        let exited = tokio::time::timeout(Duration::from_secs(5), events.exits.recv()).await.unwrap().unwrap();
        assert_eq!(exited.exit_code, 7);
        assert_eq!(exited.stderr_bytes, "synthetic-private\n".len() + 17000);
        assert_eq!(exited.stderr_lines, 1);
        assert_eq!(exited.stderr_retained_bytes, MAX_STDERR_TAIL_BYTES);
        assert_eq!(exited.stderr_tail_digest.as_ref().map(String::len), Some(16));
        assert!(exited.stderr_truncated);
        assert!(events.failures.try_recv().is_err());
        assert_eq!(log.warnings.borrow().as_slice(), ["Claude CLI emitted non-JSON stdout"]);
        assert!(!serde_json::to_string(&exited).unwrap().contains("synthetic-private"));
        transport.retire().await.unwrap();
    }).await;
}

#[tokio::test]
async fn recognizes_malformed_and_oversized_frames_and_delivers_a_split_eof_frame() {
    LocalSet::new()
        .run_until(async {
            for (bytes, maximum, expected) in [
                (
                    b"{broken\n".as_slice(),
                    200,
                    "Claude CLI emitted malformed JSON",
                ),
                (
                    b"xxxxxxxxxxxxxxxx\n".as_slice(),
                    8,
                    "Claude CLI emitted an oversized JSON frame",
                ),
            ] {
                let (mut stdout, read) = tokio::io::duplex(64);
                let child = ClaudeSubprocess {
                    stdin: None,
                    stdout: Some(Box::pin(read)),
                    stderr: None,
                    exited: Box::pin(std::future::pending()),
                    pid: None,
                    kill: Rc::new(|_| Ok(())),
                };
                let (_transport, mut events) = transport(child, Rc::default(), Some(maximum));
                stdout.write_all(bytes).await.unwrap();
                stdout.shutdown().await.unwrap();
                assert_eq!(
                    events.failures.recv().await.unwrap(),
                    ClaudeTransportFailure {
                        kind: ClaudeTransportFailureKind::Stdout,
                        message: expected.to_owned()
                    }
                );
                assert!(events.eof.try_recv().is_err());
            }
            let (mut stdout, read) = tokio::io::duplex(1);
            let (exit, exited) = oneshot::channel();
            let child = ClaudeSubprocess {
                stdin: None,
                stdout: Some(Box::pin(read)),
                stderr: None,
                exited: Box::pin(async move { exited.await.unwrap() }),
                pid: None,
                kill: Rc::new(|_| Ok(())),
            };
            let (_transport, mut events) = transport(child, Rc::default(), None);
            stdout
                .write_all(b"\xef\xbb\xbf{\"text\":\"\xc3\xa9\"}")
                .await
                .unwrap();
            stdout.shutdown().await.unwrap();
            assert_eq!(
                events.messages.recv().await.unwrap().into_value(),
                json!({"text": "\u{e9}"})
            );
            assert_eq!(events.eof.recv().await, Some(()));
            exit.send(Ok(0)).unwrap();
            assert_eq!(events.exits.recv().await.unwrap().exit_code, 0);
        })
        .await;
}

struct BlockedInput {
    at_write: Option<oneshot::Sender<()>>,
    at_close: Option<oneshot::Sender<()>>,
}

impl AsyncWrite for BlockedInput {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(at_write) = self.at_write.take() {
            let _ = at_write.send(());
        }
        Poll::Pending
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(at_close) = self.at_close.take() {
            let _ = at_close.send(());
        }
        Poll::Pending
    }
}

#[tokio::test(start_paused = true)]
async fn a_blocked_stdin_write_or_close_cannot_prevent_retirement_escalation() {
    LocalSet::new()
        .run_until(async {
            for block_write in [true, false] {
                let (write, writing) = oneshot::channel();
                let (close, mut closing) = oneshot::channel();
                let (exit, exited) = oneshot::channel();
                let exit = RefCell::new(Some(exit));
                let (signal, mut signals) = mpsc::unbounded_channel();
                let child = ClaudeSubprocess {
                    stdin: Some(Box::pin(BlockedInput {
                        at_write: Some(write),
                        at_close: Some(close),
                    })),
                    stdout: None,
                    stderr: None,
                    pid: None,
                    exited: Box::pin(async { exited.await.unwrap() }),
                    kill: Rc::new(move |sent| {
                        signal.send(sent).unwrap();
                        if sent == ClaudeProcessSignal::Kill {
                            exit.take().unwrap().send(Ok(137)).unwrap();
                        }
                        Ok(())
                    }),
                };
                let (transport, mut events) = transport(child, Rc::default(), None);
                let _writing = if block_write {
                    let pending = transport.write_line("synthetic".to_owned(), Default::default());
                    writing.await.unwrap();
                    Some(pending)
                } else {
                    None
                };
                let start = tokio::time::Instant::now();
                let retire = transport.retire();
                if !block_write {
                    (&mut closing).await.unwrap();
                }
                assert_eq!(signals.recv().await, Some(ClaudeProcessSignal::Term));
                assert_eq!(tokio::time::Instant::now() - start, PROCESS_EXIT_GRACE);
                assert!(events.exits.try_recv().is_err());
                assert_eq!(signals.recv().await, Some(ClaudeProcessSignal::Kill));
                assert_eq!(
                    tokio::time::Instant::now() - start,
                    PROCESS_EXIT_GRACE + PROCESS_EXIT_TERM
                );
                retire.await.unwrap();
                assert_eq!(events.exits.recv().await.unwrap().exit_code, 137);
                assert!(signals.try_recv().is_err());
                if block_write {
                    assert!(closing.try_recv().is_err());
                }
            }
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn only_a_started_write_failure_kills_and_reports_before_returning() {
    LocalSet::new()
        .run_until(async {
            let child = ClaudeSubprocess {
                stdin: None,
                stdout: None,
                stderr: None,
                pid: None,
                exited: Box::pin(std::future::pending()),
                kill: Rc::new(|_| panic!("no write attempt began")),
            };
            let (no_stdin, _) = transport(child, Rc::default(), None);
            assert_eq!(
                no_stdin
                    .write_line(
                        "frame".to_owned(),
                        ClaudeWriteLineOptions {
                            kill_process_after_attempt_failure: true,
                            ..Default::default()
                        }
                    )
                    .await
                    .unwrap_err()
                    .to_string(),
                "Claude CLI process has no writable stdin"
            );
            let (write, writing) = oneshot::channel();
            let (signal, mut signals) = mpsc::unbounded_channel();
            let child = ClaudeSubprocess {
                stdin: Some(Box::pin(BlockedInput {
                    at_write: Some(write),
                    at_close: None,
                })),
                stdout: None,
                stderr: None,
                pid: None,
                exited: Box::pin(std::future::pending()),
                kill: Rc::new(move |value| {
                    signal.send(value).unwrap();
                    Ok(())
                }),
            };
            let (transport, mut events) = transport(child, Rc::default(), None);
            let pending = transport.write_line(
                "frame".to_owned(),
                ClaudeWriteLineOptions {
                    attempt_timeout: Some(Duration::from_secs(1)),
                    kill_process_after_attempt_failure: true,
                    ..Default::default()
                },
            );
            writing.await.unwrap();
            assert_eq!(
                pending.await.unwrap_err().to_string(),
                "Claude CLI stdin write timed out"
            );
            assert_eq!(signals.try_recv().unwrap(), ClaudeProcessSignal::Term);
            assert!(transport.killed());
            assert_eq!(
                events.failures.try_recv().unwrap().kind,
                ClaudeTransportFailureKind::Write
            );
            assert_eq!(
                transport
                    .write_line("another-frame".to_owned(), Default::default())
                    .await
                    .unwrap_err()
                    .to_string(),
                "Claude CLI process is not writable"
            );
            assert!(events.failures.try_recv().is_err());
        })
        .await;
}
