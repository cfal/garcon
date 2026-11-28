//! Ports `server-agents/common/src/acp/__tests__/transport.test.ts`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::io;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::errors::{ErrorInput, has_node_error_code};
use garcon_js::json::{as_number, stringify};
use serde_json::{Value, json};
use tokio::time::{sleep, timeout};

use super::*;
use crate::acp::testing::{Deferred, FakeAcpControl, FakeAcpProcess, Report};

/// Names the transport cases that are tests. The transport starts local
/// tasks, so each case runs on the runtime's `LocalSet`; `paused` cases run
/// with the clock paused, as their timers are what they measure.
macro_rules! local_tests {
    (paused: $($name:ident),* $(,)?) => {
        $(#[tokio::test(start_paused = true)]
        async fn $name() {
            tokio::task::LocalSet::new()
                .run_until(timeout(Duration::from_secs(15), cases::$name()))
                .await
                .expect(concat!(stringify!($name), " did not finish"));
        })*
    };
    (real: $($name:ident),* $(,)?) => {
        $(#[tokio::test]
        async fn $name() {
            tokio::task::LocalSet::new()
                .run_until(timeout(Duration::from_secs(15), cases::$name()))
                .await
                .expect(concat!(stringify!($name), " did not finish"));
        })*
    };
}

/// How long a test polls for a condition, as the original's `waitFor` does.
const WAIT: Duration = Duration::from_secs(2);
/// How long a test waits for an answer of a real child.
const LIMIT: Duration = Duration::from_secs(5);

fn spec(command: &str, args: &[&str], env: BTreeMap<String, Option<String>>) -> AcpSpawnSpec {
    AcpSpawnSpec {
        command: command.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: env!("CARGO_MANIFEST_DIR").to_owned(),
        env,
    }
}

/// A transport over the fake process.
fn transport_for(process: Box<dyn AcpProcess>, request_timeout_ms: f64) -> AcpTransport {
    let process = RefCell::new(Some(process));
    AcpTransport::new(AcpTransportOptions {
        spawn: Some(Rc::new(move |_| {
            process
                .borrow_mut()
                .take()
                .ok_or_else(|| plain_error("the process was spawned twice"))
        })),
        request_timeout_ms: Some(request_timeout_ms),
    })
}

/// A transport over a real `sh` running `script`, in this environment.
fn shell_transport(script: &str, request_timeout_ms: f64) -> (AcpTransport, AcpSpawnSpec) {
    child_transport("sh", &["-c", script], request_timeout_ms)
}

fn child_transport(
    command: &str,
    args: &[&str],
    request_timeout_ms: f64,
) -> (AcpTransport, AcpSpawnSpec) {
    let env = std::env::vars()
        .map(|(name, value)| (name, Some(value)))
        .collect();
    (
        AcpTransport::new(AcpTransportOptions {
            spawn: None,
            request_timeout_ms: Some(request_timeout_ms),
        }),
        spec(command, args, env),
    )
}

/// A value as it crosses the wire.
fn text(value: &Value) -> String {
    stringify(value)
}

/// Lets the spawned tasks run until each waits.
async fn settle() {
    sleep(Duration::from_millis(1)).await;
}

async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(LIMIT, future)
        .await
        .expect("the operation settled in time")
}

/// `waitFor`: polls `predicate` until it holds.
async fn wait_for(mut predicate: impl FnMut() -> bool) {
    let started = tokio::time::Instant::now();
    while !predicate() {
        assert!(started.elapsed() < WAIT, "timed out waiting for condition");
        sleep(Duration::from_millis(5)).await;
    }
}

fn recorder(order: Rc<RefCell<Vec<&'static str>>>, mark: &'static str) -> SentCallback {
    Rc::new(move || {
        order.borrow_mut().push(mark);
        Ok(())
    })
}

/// A transport over a fake process whose flush the test confirms.
fn held_transport() -> (AcpTransport, FakeAcpControl, Rc<Deferred<Report>>) {
    let (process, control) = FakeAcpProcess::create();
    let flush = Rc::new(Deferred::<Report>::new());
    control.on_flush({
        let flush = Rc::clone(&flush);
        move || flush.report()
    });
    let transport = transport_for(process, 1000.0);
    transport
        .connect(&spec("agent", &[], BTreeMap::new()))
        .unwrap();
    (transport, control, flush)
}

/// The transport cases, each named after its test.
mod cases {
    use super::*;

    pub(super) async fn resolves_requests_and_clears_their_timeout() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 50.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();

        let request = transport.request("echo", None, AcpRequestOptions::default());
        control.write_stdout_line(&json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}}));

        assert_eq!(text(&request.await.unwrap()), r#"{"ok":true}"#);
        sleep(Duration::from_millis(60)).await;
        assert_eq!(
            control.written(),
            [r#"{"jsonrpc":"2.0","id":1,"method":"echo"}
"#]
        );
        assert!(transport.is_connected());
    }

    pub(super) async fn reports_a_request_as_sent_only_after_the_transport_writes_it() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 50.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let sent = Rc::new(Cell::new(0));
        let counted: SentCallback = Rc::new({
            let sent = Rc::clone(&sent);
            move || {
                sent.set(sent.get() + 1);
                Ok(())
            }
        });

        let request = transport.request(
            "echo",
            None,
            AcpRequestOptions {
                on_sent: Some(counted),
                ..Default::default()
            },
        );
        assert_eq!(sent.get(), 1);
        control.write_stdout_line(&json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}}));
        assert_eq!(text(&request.await.unwrap()), r#"{"ok":true}"#);
    }

    pub(super) async fn activates_a_flushed_prompt_before_delivering_its_first_update_or_reply() {
        let (process, control) = FakeAcpProcess::create();
        let flush = Rc::new(Deferred::<Report>::new());
        control.on_flush({
            let flush = Rc::clone(&flush);
            move || flush.report()
        });
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let order = Rc::new(RefCell::new(Vec::new()));
        let _ = transport.on_rpc_message({
            let order = Rc::clone(&order);
            move |_| {
                order.borrow_mut().push("update");
                Ok(())
            }
        });
        let prompt = transport.request(
            "session/prompt",
            Some(json!({})),
            AcpRequestOptions {
                on_sent: Some(recorder(Rc::clone(&order), "sent")),
                on_reply: Some(Rc::new({
                    let order = Rc::clone(&order);
                    move |_| {
                        order.borrow_mut().push("reply");
                        Ok(())
                    }
                })),
                ..Default::default()
            },
        );
        control.write_stdout_line(&json!({"jsonrpc": "2.0", "method": "session/update"}));
        control.write_stdout_line(&json!({"jsonrpc": "2.0", "id": 1, "result": {}}));
        control.write_stdout_line(&json!({"jsonrpc": "2.0", "method": "session/update"}));
        control.close_stdout();
        settle().await;
        assert_eq!(*order.borrow(), Vec::<&str>::new());

        flush.resolve(Ok(Some(0)));
        assert_eq!(text(&within(prompt).await.unwrap()), "{}");
        assert_eq!(*order.borrow(), ["sent", "update", "reply", "update"]);
        assert!(!transport.is_connected());
    }

    pub(super) async fn orders_buffered_output_and_exit_after_a_confirmed_prompt_write() {
        orders_buffered_output_and_exit(true).await;
    }

    pub(super) async fn orders_buffered_output_and_exit_after_a_rejected_prompt_write() {
        orders_buffered_output_and_exit(false).await;
    }

    pub(super) async fn orders_buffered_output_and_exit(confirmed: bool) {
        let (transport, control, flush) = held_transport();
        let order = Rc::new(RefCell::new(Vec::new()));
        let _ = transport.on_rpc_message({
            let order = Rc::clone(&order);
            move |_| {
                order.borrow_mut().push("update");
                Ok(())
            }
        });
        let exit = Rc::new(Deferred::<i32>::new());
        let _ = transport.on_exit({
            let exit = Rc::clone(&exit);
            move |code| exit.resolve(code)
        });
        let prompt = transport.request(
            "session/prompt",
            Some(json!({})),
            AcpRequestOptions {
                on_sent: Some(recorder(Rc::clone(&order), "sent")),
                timeout_ms: Some(0.0),
                ..Default::default()
            },
        );
        let unanswered = transport.request("unanswered", None, AcpRequestOptions::default());
        control.write_stdout_line(&json!({"method": "session/update"}));
        control.write_stdout(br#"{"id":1,"result":"final reply"}"#);
        control.close_stdout();
        control.exit(7);
        settle().await;
        assert_eq!(*order.borrow(), Vec::<&str>::new());

        if confirmed {
            flush.resolve(Ok(Some(0)));
        } else {
            flush.resolve(Err(Rc::new(io::Error::other("Prompt write failed"))));
        }
        let (reply, rejected) = tokio::join!(within(prompt), within(unanswered));
        if confirmed {
            assert_eq!(text(&reply.unwrap()), r#""final reply""#);
        } else {
            assert_eq!(reply.unwrap_err().to_string(), "Prompt write failed");
        }
        let expected: Vec<&str> = if confirmed {
            vec!["sent", "update"]
        } else {
            Vec::new()
        };
        assert_eq!(*order.borrow(), expected);
        assert!(rejected.is_err());
        assert_eq!(within(exit.shared()).await.unwrap(), 7);
        assert!(!transport.is_connected());
    }

    /// Answers `ping` and, to `finish`, writes a reply without its newline.
    const REPLYING_CHILD: &str = r#"while IFS= read -r line; do id=${line#*'"id":'}; id=${id%%,*}; case "$line" in *'"ping"'*) printf '{"id":%s,"result":"alive"}\n' "$id";; *'"finish"'*) printf '{"id":%s,"result":"final reply"}' "$id"; TERMINATE;; esac; done"#;

    pub(super) async fn accepts_a_final_unterminated_stdout_reply_when_the_child_closes_stdout() {
        final_unterminated_reply("exec 1>&-").await;
    }

    pub(super) async fn accepts_a_final_unterminated_stdout_reply_when_the_child_exits() {
        final_unterminated_reply("exit 7").await;
    }

    pub(super) async fn final_unterminated_reply(termination: &str) {
        let (transport, spec) = shell_transport(
            &REPLYING_CHILD.replacen("TERMINATE", termination, 1),
            1500.0,
        );
        transport.connect(&spec).unwrap();
        let ping = transport.request("ping", None, AcpRequestOptions::default());
        assert_eq!(text(&within(ping).await.unwrap()), r#""alive""#);
        let unanswered = transport.request("unanswered", None, AcpRequestOptions::default());
        let finish = transport.request("finish", None, AcpRequestOptions::default());
        let (unanswered, finish) = tokio::join!(within(unanswered), within(finish));
        assert_eq!(text(&finish.unwrap()), r#""final reply""#);
        let error = unanswered.unwrap_err().to_string();
        if termination.starts_with("exec") {
            assert_eq!(error, "ACP transport stdout closed");
        } else {
            assert!(
                error == "ACP transport stdout closed"
                    || error == "ACP transport process exited with code 7",
                "{error}"
            );
        }
        assert!(!transport.is_connected());
        if termination.starts_with("exit") {
            let exit = Rc::new(Deferred::<i32>::new());
            let _ = transport.on_exit({
                let exit = Rc::clone(&exit);
                move |code| exit.resolve(code)
            });
            assert_eq!(within(exit.shared()).await.unwrap(), 7);
        }
        transport.close();
    }

    /// Reads the start of the prompt, writes 512 updates to `FD`, reads the rest
    /// of the prompt to its newline, and answers with the bytes it read.
    const DRAINING_CHILD: &str = r#"
const { readSync, writeSync } = require('node:fs');
const fd = FD;
const io = async operation => {
  for (;;) {
    try { return operation(); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; await Bun.sleep(1); }
  }
};
const update = JSON.stringify({ method: 'session/update', params: 'x'.repeat(4096) }) + '\n';
const chunk = Buffer.alloc(65536);
let bytes = await io(() => readSync(0, chunk, 0, 128, null));
const output = Buffer.from(update.repeat(512));
for (let i = 0; i < output.length;) i += await io(() => writeSync(fd, output, i, output.length - i));
for (;;) {
  const n = await io(() => readSync(0, chunk, 0, chunk.length, null));
  if (!n) process.exit(1);
  bytes += n;
  if (chunk[n - 1] === 10) break;
}
process.stdout.write(JSON.stringify({ id: 1, result: bytes }) + '\n');
setInterval(() => {}, 10000);
"#;

    pub(super) async fn drains_a_real_childs_stdout_while_its_prompt_is_still_being_written() {
        drains_while_writing(1).await;
    }

    pub(super) async fn drains_a_real_childs_stderr_while_its_prompt_is_still_being_written() {
        drains_while_writing(2).await;
    }

    pub(super) async fn drains_while_writing(fd: u8) {
        let (transport, spec) = child_transport(
            "bun",
            &["-e", &DRAINING_CHILD.replace("FD", &fd.to_string())],
            2500.0,
        );
        let seen = Rc::new(RefCell::new(Vec::new()));
        let _ = transport.on_rpc_message({
            let seen = Rc::clone(&seen);
            move |_| {
                seen.borrow_mut().push("stdout");
                Ok(())
            }
        });
        let _ = transport.on_stderr({
            let seen = Rc::clone(&seen);
            move |_| seen.borrow_mut().push("stderr")
        });
        transport.connect(&spec).unwrap();
        let size = 4 * 1024 * 1024;
        let prompt = transport.request(
            "session/prompt",
            Some(json!("p".repeat(size))),
            AcpRequestOptions {
                on_sent: Some(recorder(Rc::clone(&seen), "sent")),
                ..Default::default()
            },
        );
        let answer = within(prompt).await.unwrap();
        assert!(as_number(&answer) > Some(size as f64), "{answer}");
        let mut expected = vec!["sent"];
        expected.extend(std::iter::repeat_n(
            if fd == 1 { "stdout" } else { "stderr" },
            512,
        ));
        assert_eq!(*seen.borrow(), expected);
        transport.close();
    }

    fn counter() -> (Rc<Cell<usize>>, SentCallback) {
        let count = Rc::new(Cell::new(0usize));
        let callback: SentCallback = Rc::new({
            let count = Rc::clone(&count);
            move || {
                count.set(count.get() + 1);
                Ok(())
            }
        });
        (count, callback)
    }

    fn noop() -> SentCallback {
        Rc::new(|| Ok(()))
    }

    pub(super) async fn bounds_a_stalled_send_even_when_the_turn_itself_has_no_deadline() {
        let (process, control) = FakeAcpProcess::create();
        let flush = Rc::new(Deferred::<Report>::new());
        control.on_flush({
            let flush = Rc::clone(&flush);
            move || flush.report()
        });
        let transport = transport_for(process, 10.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let (sent, callback) = counter();
        let prompt = transport.request(
            "session/prompt",
            Some(json!({})),
            AcpRequestOptions {
                on_sent: Some(callback),
                timeout_ms: Some(0.0),
                ..Default::default()
            },
        );
        let error = within(prompt).await.unwrap_err();
        assert_eq!(error.to_string(), "ACP frame write timed out");
        assert_eq!(control.kills(), [AcpSignal::Sigkill]);
        assert_eq!(sent.get(), 0);
        transport.close();
        flush.resolve(Ok(Some(0)));
    }

    pub(super) async fn retires_a_stalled_send_before_an_unterminated_output_line_can_exhaust_the_buffer()
     {
        let (transport, control, flush) = held_transport();
        let (sent, callback) = counter();
        let received = Rc::new(Cell::new(0usize));
        let _ = transport.on_rpc_message({
            let received = Rc::clone(&received);
            move |_| {
                received.set(received.get() + 1);
                Ok(())
            }
        });
        let prompt = transport.request(
            "session/prompt",
            Some(json!({})),
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        );
        control.write_stdout_line(&json!({"method": "session/update"}));
        control.write_stdout(&vec![0u8; 5 * 1024 * 1024]);
        let error = within(prompt).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "ACP output exceeded the pending send buffer"
        );
        assert_eq!(control.kills().len(), 1);
        assert_eq!(sent.get(), 0);
        assert_eq!(received.get(), 0);
        transport.close();
        flush.resolve(Ok(Some(0)));
    }

    pub(super) async fn retires_a_pipe_after_a_short_write_without_acknowledging_the_prompt() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let (sent, callback) = counter();
        control.report_next_write(StdinReport::Accepted(Some(2)));
        let prompt = transport.request(
            "session/prompt",
            Some(json!({})),
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        );
        let error = within(prompt).await.unwrap_err();
        assert_eq!(error.to_string(), "Incomplete ACP frame write");
        assert_eq!(sent.get(), 0);
        assert_eq!(control.kills(), [AcpSignal::Sigkill]);
    }

    pub(super) async fn does_not_acknowledge_a_flush_completed_after_close() {
        let (transport, _control, flush) = held_transport();
        let (sent, callback) = counter();
        let prompt = transport.request(
            "session/prompt",
            Some(json!({})),
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        );
        transport.close();
        flush.resolve(Ok(Some(0)));
        let error = within(prompt).await.unwrap_err();
        assert_eq!(error.to_string(), "ACP transport closed");
        assert_eq!(sent.get(), 0);
    }

    pub(super) async fn rejects_requests_on_timeout() {
        let (process, _) = FakeAcpProcess::create();
        let transport = transport_for(process, 5.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let error = within(transport.request("slow", None, AcpRequestOptions::default()))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "ACP request timed out after 5ms: slow");
        transport.close();
    }

    pub(super) async fn lets_a_request_opt_out_of_the_transport_timeout() {
        let (process, control) = FakeAcpProcess::create();
        // `createProcess(async () => 0)`: the flush answers with a promise.
        control.on_flush(|| StdinReport::Pending(Box::pin(async { Ok(Some(0)) })));
        let transport = transport_for(process, 5.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let request = transport.request(
            "session/prompt",
            None,
            AcpRequestOptions {
                on_sent: Some(noop()),
                timeout_ms: Some(0.0),
                ..Default::default()
            },
        );
        sleep(Duration::from_millis(20)).await;
        control.write_stdout_line(
            &json!({"jsonrpc": "2.0", "id": 1, "result": {"stopReason": "end_turn"}}),
        );
        assert_eq!(
            text(&request.await.unwrap()),
            r#"{"stopReason":"end_turn"}"#
        );
        transport.close();
    }

    pub(super) async fn rejects_pending_requests_when_closed() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let pending = transport.request("slow", None, AcpRequestOptions::default());
        transport.close();
        let error = within(pending).await.unwrap_err();
        assert_eq!(error.to_string(), "ACP transport closed");
        assert_eq!(control.kills(), [AcpSignal::Sigterm]);
    }

    pub(super) async fn rejects_pending_requests_when_the_process_exits() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let pending = transport.request("slow", None, AcpRequestOptions::default());
        control.exit(7);
        let error = within(pending).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "ACP transport process exited with code 7"
        );
    }

    pub(super) async fn reconnect_discards_the_previous_processs_partial_line() {
        let (first, previous) = FakeAcpProcess::create();
        let (second, current) = FakeAcpProcess::create();
        let processes = RefCell::new([first, second].into_iter());
        let transport = AcpTransport::new(AcpTransportOptions {
            spawn: Some(Rc::new(move |_| {
                processes
                    .borrow_mut()
                    .next()
                    .ok_or_else(|| plain_error("no process"))
            })),
            request_timeout_ms: Some(1000.0),
        });
        let spec = spec("agent", &[], BTreeMap::new());
        transport.connect(&spec).unwrap();
        previous.write_stdout(b"{");
        settle().await;
        transport.close();
        transport.connect(&spec).unwrap();
        let pending = transport.request("ping", None, AcpRequestOptions::default());
        current.write_stdout_line(&json!({"id": 1, "result": "pong"}));
        assert_eq!(within(pending).await.unwrap(), json!("pong"));
        transport.close();
    }

    pub(super) async fn tells_a_listener_attached_after_the_process_exited_about_the_exit() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        control.exit(9);
        settle().await;
        let exit = Rc::new(Deferred::<i32>::new());
        let _ = transport.on_exit({
            let exit = Rc::clone(&exit);
            move |code| exit.resolve(code)
        });
        assert_eq!(within(exit.shared()).await.unwrap(), 9);
    }

    pub(super) async fn writes_notifications_without_an_id() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        transport
            .notify("session/cancel", Some(json!({"sessionId": "session-1"})))
            .unwrap();
        assert_eq!(
            control.written(),
            [
                r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}
"#
            ]
        );
        transport.close();
    }

    pub(super) async fn matches_the_originals_json_rpc_wire_bytes() {
        let mut original = tokio::process::Command::new("bun");
        original
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/acp-transport-wire.ts"
            ))
            .kill_on_drop(true);
        let original = within(original.output()).await.unwrap();
        assert!(
            original.status.success(),
            "{}",
            String::from_utf8_lossy(&original.stderr)
        );
        let expected: Value = garcon_js::json::from_slice(&original.stdout).unwrap();
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        let stderr = Rc::new(RefCell::new(Vec::new()));
        let _ = transport.on_stderr({
            let stderr = Rc::clone(&stderr);
            move |line| stderr.borrow_mut().push(line.to_owned())
        });
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let request = transport.request(
            "echo",
            Some(json!({"z": 1, "2": "second", "a": null, "1": "first"})),
            AcpRequestOptions::default(),
        );
        transport
            .notify("session/cancel", Some(json!({"sessionId": "session-1"})))
            .unwrap();
        transport
            .respond(
                AcpJsonRpcId::String("permission-1".to_owned()),
                json!({
                    "outcome": "selected", "optionId": "deny"
                }),
            )
            .unwrap();
        transport
            .respond_error(
                AcpJsonRpcId::Number(42.0),
                -32601.0,
                "Method not found",
                None,
            )
            .unwrap();
        control.write_stdout(b"not json\n{\"id\":1,\"result\":{\"ok\":true}}\n");
        assert_eq!(within(request).await.unwrap(), expected["reply"]);
        assert_eq!(json!(control.written()), expected["frames"]);
        let lines = stderr.borrow();
        let prefix = "ACP transport received invalid JSON: ";
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with(prefix), "{lines:?}");
        assert!(expected["stderr"][0].as_str().unwrap().starts_with(prefix));
        transport.close();
    }

    /// A `sh` that closes its stdin, says so on stderr, and stays alive.
    const CLOSED_INPUT_CHILD: &str = "exec 0<&-; printf 'closed\\n' >&2; exec sleep 30";

    pub(super) async fn replaces_the_childs_environment_and_leaves_out_an_undefined_value() {
        // The child answers with the three variables it was given and with
        // `PATH`, which it was not; `b` is `set` only where `B` exists.
        let transport = AcpTransport::new(AcpTransportOptions {
            spawn: None,
            request_timeout_ms: Some(1500.0),
        });
        let script = r#"printf '{"a":"%s","b":"%s","c":"%s","path":"%s"}\n' "$A" "${B+set}" "$C" "$(env | grep '^PATH=')""#;
        let env = BTreeMap::from([
            ("A".to_owned(), Some("1".to_owned())),
            ("B".to_owned(), None),
            ("C".to_owned(), Some("3".to_owned())),
        ]);
        let answer = Rc::new(RefCell::new(None));
        let _ = transport.on_rpc_message({
            let answer = Rc::clone(&answer);
            move |message| {
                *answer.borrow_mut() = Some(text(message));
                Ok(())
            }
        });
        let exit = Rc::new(Deferred::<i32>::new());
        let _ = transport.on_exit({
            let exit = Rc::clone(&exit);
            move |code| exit.resolve(code)
        });
        transport
            .connect(&spec("sh", &["-c", script], env))
            .unwrap();
        assert_eq!(within(exit.shared()).await.unwrap(), 0);
        let answer = answer.borrow();
        assert_eq!(
            answer.as_deref(),
            Some(r#"{"a":"1","b":"","c":"3","path":""}"#)
        );
    }

    pub(super) async fn confirms_a_small_write_at_once() {
        let (transport, spec) = shell_transport("exec cat", 1000.0);
        let messages = Rc::new(RefCell::new(Vec::new()));
        let _ = transport.on_rpc_message({
            let messages = Rc::clone(&messages);
            move |message| {
                messages.borrow_mut().push(text(message));
                Ok(())
            }
        });
        transport.connect(&spec).unwrap();
        let (sent, callback) = counter();
        // The echoed frame carries an id but no result: it is a message, not
        // the request's reply, which stays pending until the transport closes.
        drop(transport.request(
            "ping",
            Some(json!({"x": 1})),
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        ));
        // `stdin.write` and `stdin.flush` both answer with a byte count: there
        // is nothing to wait for before the send is confirmed.
        assert_eq!(sent.get(), 1);
        wait_for(|| messages.borrow().len() == 1).await;
        assert_eq!(
            messages.borrow()[0],
            r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":1}}"#
        );
        transport.close();
    }

    pub(super) async fn reports_a_broken_pipe_once_the_child_closed_its_input() {
        let (transport, spec) = shell_transport(CLOSED_INPUT_CHILD, 1000.0);
        let lines = Rc::new(RefCell::new(Vec::<String>::new()));
        let _ = transport.on_stderr({
            let lines = Rc::clone(&lines);
            move |line| lines.borrow_mut().push(line.to_owned())
        });
        let exit = Rc::new(Deferred::<i32>::new());
        let _ = transport.on_exit({
            let exit = Rc::clone(&exit);
            move |code| exit.resolve(code)
        });
        transport.connect(&spec).unwrap();
        wait_for(|| lines.borrow().last().map(String::as_str) == Some("closed")).await;
        let (sent, callback) = counter();
        let request = transport.request(
            "ping",
            None,
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        );
        let error = within(request).await.unwrap_err();
        assert!(
            has_node_error_code(ErrorInput::Error(error.as_ref()), "EPIPE"),
            "{error}"
        );
        assert_eq!(error.to_string(), "EPIPE: broken pipe, write");
        assert_eq!(sent.get(), 0);
        // The pipe is closed with SIGKILL: 128 plus the signal.
        assert_eq!(within(exit.shared()).await.unwrap(), 137);
    }

    pub(super) async fn reports_a_broken_pipe_when_a_pending_flush_loses_its_reader() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("close-stdin");
        let (_, spec) = child_transport(
            "sh",
            &[
                "-c",
                r#"while [ ! -f "$1" ]; do sleep 0.01; done; exec 0<&-; exec sleep 30"#,
                "agent",
                marker.to_str().unwrap(),
            ],
            1000.0,
        );
        let mut process = pipe::spawn(&spec).unwrap();
        let stdin = process.stdin().unwrap();
        let written = stdin
            .borrow_mut()
            .write(&vec![b'x'; MAX_OUTPUT_DURING_SEND])
            .unwrap();
        let flushed = flush(&stdin, None, false, 0).unwrap();
        std::fs::write(&marker, b"").unwrap();
        let result = match flushed {
            FrameFlush::Pending(flushed) => Some(timeout(LIMIT, flushed).await),
            FrameFlush::Settled => None,
        };
        process.kill(AcpSignal::Sigterm);
        within(process.exited()).await.unwrap();
        assert!(matches!(written, StdinReport::Pending(_)));
        let error = result
            .expect("flush must wait for the pipe to drain")
            .expect("flush must fail when its reader closes")
            .unwrap_err();
        assert_eq!(error.to_string(), "EPIPE: broken pipe, write");
        assert!(has_node_error_code(
            ErrorInput::Error(error.as_ref()),
            "EPIPE"
        ));
    }

    pub(super) async fn reports_nothing_for_an_unconfirmed_write_the_child_will_not_read() {
        let (transport, spec) = shell_transport(CLOSED_INPUT_CHILD, 1000.0);
        let lines = Rc::new(RefCell::new(Vec::<String>::new()));
        let _ = transport.on_stderr({
            let lines = Rc::clone(&lines);
            move |line| lines.borrow_mut().push(line.to_owned())
        });
        let exited = Rc::new(Cell::new(false));
        let _ = transport.on_exit({
            let exited = Rc::clone(&exited);
            move |_| exited.set(true)
        });
        transport.connect(&spec).unwrap();
        wait_for(|| lines.borrow().last().map(String::as_str) == Some("closed")).await;
        transport.notify("session/cancel", None).unwrap();
        sleep(Duration::from_millis(50)).await;
        assert!(transport.is_connected());
        assert!(!exited.get());
        transport.close();
    }

    pub(super) async fn closes_on_rejection_of_an_unconfirmed_write() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let write = Deferred::<Report>::new();
        control.report_next_write(write.report());
        transport.notify("session/cancel", None).unwrap();
        let pending = transport.request("pending", None, AcpRequestOptions::default());
        assert!(transport.is_connected());

        write.resolve(Err(Rc::new(io::Error::other("write rejected"))));
        assert_eq!(
            within(pending).await.unwrap_err().to_string(),
            "write rejected"
        );
        assert_eq!(control.kills(), [AcpSignal::Sigkill]);
        assert!(!transport.is_connected());
    }

    pub(super) async fn treats_a_write_after_the_process_exited_as_incomplete_only_when_confirmed()
    {
        // Bun's sink answers `true` for it: with nothing to confirm, the frame
        // counts as written.
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        control.report_next_write(StdinReport::Closed);
        transport.notify("session/cancel", None).unwrap();
        assert!(control.kills().is_empty());
        assert!(transport.is_connected());
        let (sent, callback) = counter();
        control.report_next_write(StdinReport::Closed);
        let prompt = transport.request(
            "session/prompt",
            None,
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        );
        let error = within(prompt).await.unwrap_err();
        assert_eq!(error.to_string(), "Incomplete ACP frame write");
        assert_eq!(sent.get(), 0);
        assert_eq!(control.kills(), [AcpSignal::Sigkill]);
    }

    pub(super) async fn emits_each_stderr_line_and_its_own_diagnostics_about_invalid_json() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        let lines = Rc::new(RefCell::new(Vec::new()));
        let _ = transport.on_stderr({
            let lines = Rc::clone(&lines);
            move |line| lines.borrow_mut().push(line.to_owned())
        });
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        control.write_stderr_line("first");
        control.write_stderr(b"  second  \n\n");
        control.write_stdout(b"not json\n");
        settle().await;
        // The two pipes are read concurrently, so the lines of each keep their
        // order and the pipes may interleave either way.
        let lines = lines.borrow();
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert!(lines.iter().any(|line| line == "first"), "{lines:?}");
        assert!(lines.iter().any(|line| line == "second"), "{lines:?}");
        assert!(
            lines
                .iter()
                .any(|line| line.starts_with("ACP transport received invalid JSON: ")),
            "{lines:?}"
        );
        transport.close();
    }

    pub(super) async fn closes_with_the_failure_of_a_read() {
        let (process, control) = FakeAcpProcess::create();
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let pending = transport.request("slow", None, AcpRequestOptions::default());
        control.fail_stdout("Synthetic stdout failure");
        let error = within(pending).await.unwrap_err();
        assert_eq!(error.to_string(), "Synthetic stdout failure");
        assert_eq!(control.kills(), [AcpSignal::Sigkill]);
        assert!(!transport.is_connected());
    }

    pub(super) async fn kills_without_waiting_for_an_exit_the_process_defers() {
        let (process, control) = FakeAcpProcess::create();
        let gate = Rc::new(Deferred::<()>::new());
        control.exit_after_kill(&gate);
        let transport = transport_for(process, 1000.0);
        let exit = Rc::new(Cell::new(0));
        let _ = transport.on_exit({
            let exit = Rc::clone(&exit);
            move |code| exit.set(code)
        });
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        transport.close();
        assert_eq!(control.kills(), [AcpSignal::Sigterm]);
        settle().await;
        assert_eq!(exit.get(), 0);
        gate.resolve(());
        settle().await;
        assert_eq!(exit.get(), 143);
    }

    pub(super) async fn confirms_a_send_at_once_when_the_sink_takes_the_whole_frame() {
        let (process, control) = FakeAcpProcess::create();
        control.on_write(|frame| frame.len());
        let transport = transport_for(process, 1000.0);
        transport
            .connect(&spec("agent", &[], BTreeMap::new()))
            .unwrap();
        let (sent, callback) = counter();
        let request = transport.request(
            "ping",
            None,
            AcpRequestOptions {
                on_sent: Some(callback),
                ..Default::default()
            },
        );
        assert_eq!(sent.get(), 1);
        control.write_stdout_line(&json!({"jsonrpc": "2.0", "id": 1, "result": "pong"}));
        assert_eq!(text(&request.await.unwrap()), r#""pong""#);
        transport.close();
    }
}

#[test]
fn decodes_byte_streams_as_textdecoder_does() {
    let fixture = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/acp-textdecoder.json"
    ))
    .unwrap();
    let cases: Value = garcon_js::json::from_str(&fixture).unwrap();
    let cases = cases.as_array().unwrap();
    assert!(cases.len() > 100, "{} cases", cases.len());
    for case in cases {
        let chunks = case["chunks"].as_array().unwrap();
        let mut buffer = LineBuffer::new();
        let mut text = String::new();
        for (index, chunk) in chunks.iter().enumerate() {
            let bytes: Vec<u8> = chunk
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect();
            text.push_str(&buffer.decode(&bytes, index + 1 == chunks.len()));
        }
        assert_eq!(text, case["text"].as_str().unwrap(), "{case}");
    }
}

local_tests! {
    paused:
        resolves_requests_and_clears_their_timeout,
        reports_a_request_as_sent_only_after_the_transport_writes_it,
        activates_a_flushed_prompt_before_delivering_its_first_update_or_reply,
        orders_buffered_output_and_exit_after_a_confirmed_prompt_write,
        orders_buffered_output_and_exit_after_a_rejected_prompt_write,
        bounds_a_stalled_send_even_when_the_turn_itself_has_no_deadline,
        retires_a_stalled_send_before_an_unterminated_output_line_can_exhaust_the_buffer,
        retires_a_pipe_after_a_short_write_without_acknowledging_the_prompt,
        does_not_acknowledge_a_flush_completed_after_close,
        rejects_requests_on_timeout,
        lets_a_request_opt_out_of_the_transport_timeout,
        rejects_pending_requests_when_closed,
        rejects_pending_requests_when_the_process_exits,
        reconnect_discards_the_previous_processs_partial_line,
        tells_a_listener_attached_after_the_process_exited_about_the_exit,
        writes_notifications_without_an_id,
        closes_on_rejection_of_an_unconfirmed_write,
        treats_a_write_after_the_process_exited_as_incomplete_only_when_confirmed,
        emits_each_stderr_line_and_its_own_diagnostics_about_invalid_json,
        closes_with_the_failure_of_a_read,
        kills_without_waiting_for_an_exit_the_process_defers,
        confirms_a_send_at_once_when_the_sink_takes_the_whole_frame,
}

local_tests! {
    real:
        matches_the_originals_json_rpc_wire_bytes,
        accepts_a_final_unterminated_stdout_reply_when_the_child_closes_stdout,
        accepts_a_final_unterminated_stdout_reply_when_the_child_exits,
        drains_a_real_childs_stdout_while_its_prompt_is_still_being_written,
        drains_a_real_childs_stderr_while_its_prompt_is_still_being_written,
        replaces_the_childs_environment_and_leaves_out_an_undefined_value,
        confirms_a_small_write_at_once,
        reports_a_broken_pipe_once_the_child_closed_its_input,
        reports_a_broken_pipe_when_a_pending_flush_loses_its_reader,
        reports_nothing_for_an_unconfirmed_write_the_child_will_not_read,
}
