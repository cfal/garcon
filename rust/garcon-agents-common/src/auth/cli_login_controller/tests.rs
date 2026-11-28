use super::*;

use garcon_cases::{CaseError, replay, text};
use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream};
use tokio::task::LocalSet;

#[derive(Default)]
struct Logger(RefCell<Vec<String>>);
impl AgentLogger for Logger {
    fn debug(&self, message: &str, _: Option<&IndexMap<String, Opaque>>) {
        self.0.borrow_mut().push(message.to_owned());
    }
    fn info(&self, message: &str, _: Option<&IndexMap<String, Opaque>>) {
        self.0.borrow_mut().push(message.to_owned());
    }
    fn warn(&self, message: &str, _: Option<&IndexMap<String, Opaque>>) {
        self.0.borrow_mut().push(message.to_owned());
    }
    fn error(&self, message: &str, _: Option<&IndexMap<String, Opaque>>) {
        self.0.borrow_mut().push(message.to_owned());
    }
}

fn options(logger: Rc<Logger>) -> CliLoginControllerOptions {
    let mut opts = CliLoginControllerOptions::new(
        || CliLoginCommand {
            executable: "synthetic-cli".into(),
            args: vec!["login".into()],
        },
        CliLoginMode::BrowserCode,
        logger,
    );
    let sequence = Cell::new(0);
    opts.new_session_id = Rc::new(move || {
        sequence.set(sequence.get() + 1);
        format!("synthetic-attempt-{}", sequence.get())
    });
    opts
}

struct Fixture {
    input: BufReader<DuplexStream>,
    stdout: DuplexStream,
    stderr: DuplexStream,
    exit: Rc<RefCell<Option<oneshot::Sender<i32>>>>,
    kills: Rc<Cell<usize>>,
}

fn fixture() -> (Fixture, CliLoginProcess) {
    let (input, stdin) = tokio::io::duplex(4096);
    let (stdout, stdout_reader) = tokio::io::duplex(4096);
    let (stderr, stderr_reader) = tokio::io::duplex(4096);
    let (exit, exited) = oneshot::channel();
    let exit = Rc::new(RefCell::new(Some(exit)));
    let kills = Rc::new(Cell::new(0));
    let kill_count = kills.clone();
    let kill = Rc::new(move || {
        kill_count.set(kill_count.get() + 1);
        Ok(())
    });
    (
        Fixture {
            input: BufReader::new(input),
            stdout,
            stderr,
            exit,
            kills,
        },
        CliLoginProcess {
            stdin: Some(Box::pin(stdin)),
            stdout: Some(Box::pin(stdout_reader)),
            stderr: Some(Box::pin(stderr_reader)),
            exited: Box::pin(async move { exited.await.map_err(io::Error::other) }),
            kill,
        },
    )
}

fn fake_controller(
    process: CliLoginProcess,
    mut opts: CliLoginControllerOptions,
) -> CliLoginController {
    let process = RefCell::new(Some(process));
    opts.spawn_process = Some(Rc::new(move |_, _| {
        process
            .take()
            .ok_or_else(|| io::Error::other("process already used"))
    }));
    CliLoginController::new(opts)
}

const URL_LINE: &[u8] = b"Open https://auth.example/login\n";

#[test]
fn recorded_login_parsers_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/cli-login-controller"
        ),
        |function, args| {
            let raw = text(function, args.first())?.expect("recorded string");
            let parsed = match function {
                "parseBrowserAuth" => parse_browser_auth(raw),
                "parseDeviceAuth" => parse_device_auth(raw),
                "new CliLoginSessionError" => {
                    use garcon_base::errors::DiagnosticError;
                    let error = CliLoginSessionError::new(raw);
                    let metadata = error.diagnostic_metadata();
                    return Ok(serde_json::json!({
                        "$": "error", "name": metadata.name, "message": error.0.message,
                        "properties": { "code": metadata.code, "retryable": error.0.retryable },
                    }));
                }
                _ => return Err(CaseError::unhandled(function)),
            };
            Ok(garcon_js::json::from_slice(&serde_json::to_vec(&parsed).unwrap()).unwrap())
        },
    );
}

#[tokio::test]
async fn owns_one_session_per_controller_and_keeps_stdin_open_while_rejecting_duplicate_completion()
{
    LocalSet::new()
        .run_until(async {
            let (mut fixture, process) = fixture();
            let (succeeded, settled) = oneshot::channel();
            let succeeded = RefCell::new(Some(succeeded));
            let mut opts = options(Rc::new(Logger::default()));
            opts.on_succeeded = Some(Rc::new(move || {
                let _ = succeeded.take().unwrap().send(());
            }));
            let controller = fake_controller(process, opts);
            fixture.stdout.write_all(URL_LINE).await.unwrap();
            let launch = controller.launch().await.unwrap();
            let newer = controller.launch().await.unwrap();
            assert_eq!(newer.session_id, launch.session_id);
            assert!(newer.already_running && !newer.launched);
            let id = &launch.session_id;
            assert!(
                controller
                    .complete(id, " callback-code ")
                    .await
                    .unwrap()
                    .submitted
            );
            let mut line = String::new();
            fixture.input.read_line(&mut line).await.unwrap();
            assert_eq!(line, "callback-code\n");
            let err = controller.complete(id, "second-code").await.unwrap_err();
            assert_eq!(err.to_string(), "Auth login completion is already pending");
            assert!(matches!(
                controller.status(Some(id)),
                AgentAuthLoginStatus::Running {
                    completion_pending: true,
                    ..
                }
            ));
            fixture.stdout.shutdown().await.unwrap();
            fixture.stderr.shutdown().await.unwrap();
            fixture.exit.take().unwrap().send(0).unwrap();
            settled.await.unwrap();
            assert!(matches!(
                controller.status(Some(id)),
                AgentAuthLoginStatus::Succeeded { .. }
            ));
            controller.stop();
        })
        .await;
}

#[tokio::test]
async fn validates_codes_before_writing_and_retires_uncertain_writes() {
    LocalSet::new().run_until(async {
        let (mut fixture, process) = fixture();
        let log = Rc::new(Logger::default());
        let mut opts = options(log.clone());
        opts.validate_code = Some(Rc::new(|code| (!code.contains('#')).then(|| "Full code required.".to_owned())));
        let controller = fake_controller(process, opts);
        fixture.stdout.write_all(URL_LINE).await.unwrap();
        let id = controller.launch().await.unwrap().session_id;
        let err = controller.complete(&id, "synthetic-secret").await.unwrap_err();
        let err = err.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(err.code, AgentIntegrationErrorCode::AUTH_LOGIN_CODE_INVALID);
        assert!(err.retryable);
        assert!(matches!(controller.status(Some(&id)), AgentAuthLoginStatus::Running { completion_pending: false, retryable_error: Some(error), .. } if error == "Full code required."));
        controller.complete(&id, "full#code").await.unwrap();
        let mut written = String::new();
        fixture.input.read_line(&mut written).await.unwrap();
        assert_eq!(written, "full#code\n");
        controller.stop();

        let (fixture2, process) = self::fixture();
        let controller = fake_controller(process, options(log.clone()));
        let Fixture { input, mut stdout, kills, .. } = fixture2;
        stdout.write_all(URL_LINE).await.unwrap();
        let id = controller.launch().await.unwrap().session_id;
        drop(input);
        assert_eq!(controller.complete(&id, "full#code").await.unwrap_err().to_string(), SESSION_FAILED_ERROR);
        assert!(matches!(controller.status(Some(&id)), AgentAuthLoginStatus::Failed { error, .. } if error == SESSION_FAILED_ERROR));
        assert_eq!(kills.get(), 1);
        assert!(!log.0.borrow().iter().any(|line| line.contains("synthetic-secret")));
    }).await;
}

#[tokio::test]
async fn drains_real_process_pipes_after_url_and_retries_without_closing_stdin() {
    LocalSet::new().run_until(async {
        let (rejected, wait_rejected) = oneshot::channel();
        let rejected = RefCell::new(Some(rejected));
        let (succeeded, wait_succeeded) = oneshot::channel();
        let succeeded = RefCell::new(Some(succeeded));
        let mut opts = options(Rc::new(Logger::default()));
        opts.command = Rc::new(|| CliLoginCommand { executable: "bun".into(), args: vec!["-e".into(), r#"
            const { createInterface } = require('node:readline');
            process.stdout.write('Open https://auth.example/');
            process.stderr.write('other stream\n');
            process.stdout.write('login?complete=url\n');
            createInterface({ input: process.stdin }).on('line', (code) => {
              if (!code.includes('#')) {
                process.stderr.write('x'.repeat(100_000) + '\nSynthetic code ');
                process.stdout.write('other line\n');
                process.stderr.write('rejected.\n');
              } else process.stderr.write('x'.repeat(2 * 1024 * 1024) + '\n', () => process.exit(0));
            });
        "#.into()] });
        opts.parse_output_error = Some(Rc::new(move |line| (line == "Synthetic code rejected.").then(|| {
            let _ = rejected.take().unwrap().send(());
            CliLoginOutputError { retryable: true, message: "Copy the full code.".into() }
        })));
        opts.on_succeeded = Some(Rc::new(move || { let _ = succeeded.take().unwrap().send(()); }));
        let controller = CliLoginController::new(opts);
        let launch = controller.launch().await.unwrap();
        assert_eq!(launch.device_auth.unwrap().url, "https://auth.example/login?complete=url");
        controller.complete(&launch.session_id, "partial").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), wait_rejected).await.unwrap().unwrap();
        assert!(matches!(controller.status(Some(&launch.session_id)), AgentAuthLoginStatus::Running { completion_pending: false, retryable_error: Some(error), .. } if error == "Copy the full code."));
        controller.complete(&launch.session_id, "complete#suffix").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), wait_succeeded).await.unwrap().unwrap();
        assert!(matches!(controller.status(Some(&launch.session_id)), AgentAuthLoginStatus::Succeeded { .. }));
        controller.stop();
    }).await;
}

#[tokio::test(start_paused = true)]
async fn expires_and_kills_pending_process_and_keeps_timeout_despite_its_later_exit() {
    LocalSet::new().run_until(async {
        let (mut fixture, process) = fixture();
        let mut opts = options(Rc::new(Logger::default()));
        opts.session_timeout = Duration::from_secs(1);
        opts.terminal_status_ttl = Duration::from_secs(1);
        let controller = fake_controller(process, opts);
        fixture.stdout.write_all(URL_LINE).await.unwrap();
        let id = controller.launch().await.unwrap().session_id;
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(fixture.kills.get(), 1);
        fixture.exit.take().unwrap().send(0).unwrap();
        fixture.stdout.shutdown().await.unwrap();
        fixture.stderr.shutdown().await.unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(controller.status(Some(&id)), AgentAuthLoginStatus::Failed { error, .. } if error == SESSION_EXPIRED_ERROR));
        assert_eq!(controller.complete(&id, "synthetic-code").await.unwrap_err().to_string(), "No matching pending auth login");
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(matches!(controller.status(Some(&id)), AgentAuthLoginStatus::Failed { error, .. } if error == SESSION_UNAVAILABLE_ERROR));
    }).await;
}

#[tokio::test]
async fn parses_device_codes_and_kills_active_processes_during_stop() {
    LocalSet::new()
        .run_until(async {
            let mut opts = options(Rc::new(Logger::default()));
            opts.mode = CliLoginMode::DeviceCode;
            let (events, receive) = mpsc::unbounded_channel();
            events
                .send(CliLoginPtyEvent::Data(
                    "Visit https://auth.example/device\n  WXYZ-1234\n".into(),
                ))
                .unwrap();
            let kills = Rc::new(Cell::new(0));
            let kill_count = kills.clone();
            let pty = RefCell::new(Some(CliLoginPty {
                events: receive,
                kill: Rc::new(move || {
                    kill_count.set(kill_count.get() + 1);
                    Ok(())
                }),
            }));
            opts.spawn_pty = Some(Rc::new(move |_, _| {
                let pty = pty.take().unwrap();
                Box::pin(async { Ok(pty) })
            }));
            let controller = CliLoginController::new(opts);
            let launched = controller.launch().await.unwrap();
            assert_eq!(
                launched.device_auth.unwrap().code.as_deref(),
                Some("WXYZ-1234")
            );
            assert!(matches!(
                controller.status(None),
                AgentAuthLoginStatus::Running {
                    completion_pending: false,
                    ..
                }
            ));
            controller.stop();
            assert_eq!(kills.get(), 1);
            drop(events);
        })
        .await;
}

#[test]
fn utf8_buffer_only_retains_a_trailing_incomplete_sequence() {
    assert_eq!(complete_utf8_prefix(b"\xe2x\xf0\x9f"), 2);
    assert_eq!(complete_utf8_prefix(b"x\xc3\xa9"), 3);
    assert_eq!(complete_utf8_prefix(b"\xef\xbb"), 0);
}

#[tokio::test]
async fn classifies_terminal_failures_after_draining_diagnostics_without_exposing_raw_output() {
    LocalSet::new().run_until(async {
        let (mut fixture, process) = fixture();
        let log = Rc::new(Logger::default());
        let mut opts = options(log.clone());
        opts.parse_output_error = Some(Rc::new(|line| line.starts_with("Failure:").then(|| CliLoginOutputError {
            retryable: false,
            message: "Provider sign-in failed. Start again.".to_owned(),
        })));
        let controller = fake_controller(process, opts);
        fixture.stdout.write_all(URL_LINE).await.unwrap();
        let id = controller.launch().await.unwrap().session_id;
        fixture.exit.take().unwrap().send(1).unwrap();
        assert!(matches!(controller.status(Some(&id)), AgentAuthLoginStatus::Running { .. }));
        fixture.stderr.write_all(b"Failure: synthetic-secret-token\n").await.unwrap();
        fixture.stdout.shutdown().await.unwrap();
        fixture.stderr.shutdown().await.unwrap();
        let terminal = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = controller.status(Some(&id));
                if !matches!(status, AgentAuthLoginStatus::Running { .. }) { break status; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert!(matches!(terminal, AgentAuthLoginStatus::Failed { error, .. } if error == "Provider sign-in failed. Start again."));
        assert!(!log.0.borrow().iter().any(|line| line.contains("synthetic-secret-token")));
    }).await;
}

#[tokio::test]
async fn ignores_stale_output_and_exit_callbacks_after_a_stopped_session_is_replaced() {
    LocalSet::new()
        .run_until(async {
            let (mut old, old_process) = fixture();
            let (mut next, new_process) = fixture();
            let mut opts = options(Rc::new(Logger::default()));
            let children = RefCell::new(vec![new_process, old_process]);
            opts.spawn_process = Some(Rc::new(move |_, _| {
                children
                    .borrow_mut()
                    .pop()
                    .ok_or_else(|| io::Error::other("process already used"))
            }));
            let output_count = Rc::new(Cell::new(0));
            let counter = output_count.clone();
            opts.parse_output_error = Some(Rc::new(move |line| {
                (line == "Stale output").then(|| {
                    counter.set(counter.get() + 1);
                    CliLoginOutputError {
                        retryable: true,
                        message: "stale rejection".to_owned(),
                    }
                })
            }));
            let controller = CliLoginController::new(opts);
            old.stdout.write_all(URL_LINE).await.unwrap();
            let prior = controller.launch().await.unwrap();
            controller.stop();
            next.stdout.write_all(URL_LINE).await.unwrap();
            let later = controller.launch().await.unwrap();
            assert_ne!(prior.session_id, later.session_id);
            controller
                .complete(&later.session_id, "synthetic-code")
                .await
                .unwrap();
            old.stderr.write_all(b"Stale output\n").await.unwrap();
            old.stderr.write_all(&[b'x'; 8192]).await.unwrap();
            old.exit.take().unwrap().send(1).unwrap();
            old.stdout.shutdown().await.unwrap();
            old.stderr.shutdown().await.unwrap();
            assert_eq!(output_count.get(), 0);
            assert!(matches!(
                controller.status(Some(&later.session_id)),
                AgentAuthLoginStatus::Running {
                    completion_pending: true,
                    retryable_error: None,
                    ..
                }
            ));
            controller.stop();
        })
        .await;
}

#[tokio::test]
async fn does_not_publish_a_url_after_stop_interrupts_its_discovery() {
    LocalSet::new()
        .run_until(async {
            let (mut fixture, process) = fixture();
            let controller = fake_controller(process, options(Rc::new(Logger::default())));
            let launching = controller.clone();
            let launch = tokio::task::spawn_local(async move { launching.launch().await });
            while matches!(controller.status(None), AgentAuthLoginStatus::Idle { .. }) {
                tokio::task::yield_now().await;
            }
            controller.stop();
            fixture.stdout.write_all(URL_LINE).await.unwrap();
            assert_eq!(
                launch.await.unwrap().unwrap_err().to_string(),
                SESSION_UNAVAILABLE_ERROR
            );
            assert!(matches!(
                controller.status(None),
                AgentAuthLoginStatus::Idle { .. }
            ));
        })
        .await;
}
