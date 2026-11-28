use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use garcon_agent_pi::pi_rpc_client::{
    DEFAULT_RESPONSE_TIMEOUT_MS, PiRpcClient, PiRpcClientOptions, PiRpcCommandError,
    PiRpcTransportError,
};
use garcon_js::json;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, duplex};
use tokio::sync::watch;
use tokio::task::LocalSet;

struct Harness {
    client: PiRpcClient,
    inbound: BufReader<DuplexStream>,
    outbound: DuplexStream,
    exit: watch::Sender<Option<i32>>,
    events: Rc<RefCell<Vec<String>>>,
    malformed: Rc<RefCell<Vec<String>>>,
}

impl Harness {
    fn new(stdin_capacity: usize) -> Self {
        let (stdin, inbound) = duplex(stdin_capacity);
        let (outbound, stdout) = duplex(1024);
        let (exit, exited) = watch::channel(None);
        let events = Rc::<RefCell<Vec<String>>>::default();
        let malformed = Rc::<RefCell<Vec<String>>>::default();
        let client = PiRpcClient::new(
            Some(Box::new(stdin)),
            Some(Box::new(stdout)),
            exited,
            Rc::new(Cell::new(false)),
            PiRpcClientOptions {
                on_event: Rc::new({
                    let events = events.clone();
                    move |event| events.borrow_mut().push(json::stringify(event.as_value()))
                }),
                on_malformed: Rc::new({
                    let malformed = malformed.clone();
                    move |line| malformed.borrow_mut().push(line.to_owned())
                }),
            },
        );
        Self {
            client,
            inbound: BufReader::new(inbound),
            outbound,
            exit,
            events,
            malformed,
        }
    }

    async fn line(&mut self) -> String {
        let mut line = String::new();
        self.inbound.read_line(&mut line).await.unwrap();
        line
    }

    async fn emit(&mut self, value: &Value) {
        self.outbound
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }
}

fn command(kind: &str) -> Map<String, Value> {
    Map::from_iter([("type".to_owned(), json!(kind))])
}

#[tokio::test]
async fn writes_full_lines_and_correlates_out_of_order_responses() {
    LocalSet::new()
        .run_until(async {
            let mut io = Harness::new(4);
            let mut first = command("get_state");
            first.insert("id".to_owned(), json!("caller-supplied"));
            let first = io.client.send(first, DEFAULT_RESPONSE_TIMEOUT_MS, None);
            let second = io
                .client
                .send(command("get_state"), DEFAULT_RESPONSE_TIMEOUT_MS, None);
            assert_eq!(
                io.line().await,
                "{\"type\":\"get_state\",\"id\":\"garcon-1\"}\n"
            );
            assert_eq!(
                io.line().await,
                "{\"type\":\"get_state\",\"id\":\"garcon-2\"}\n"
            );

            io.emit(
                &json!({"type":"response","id":"garcon-2","success":true,"data":{"n":"second"}}),
            )
            .await;
            io.emit(&json!({"type":"agent_start"})).await;
            io.emit(
                &json!({"type":"response","id":"garcon-1","success":true,"data":{"n":"first"}}),
            )
            .await;

            let second = second.await.unwrap();
            let first = first.await.unwrap();
            assert_eq!(second.command, "get_state");
            assert_eq!(second.data.unwrap()["n"], "second");
            assert_eq!(first.data.unwrap()["n"], "first");
            assert_eq!(*io.events.borrow(), [r#"{"type":"agent_start"}"#]);
        })
        .await;
}

#[tokio::test]
async fn observes_acceptance_before_the_next_event_in_the_frame_batch() {
    LocalSet::new().run_until(async {
        let mut io = Harness::new(1024);
        let events = io.events.clone();
        let pending = io.client.send_unbounded(command("prompt"), Some(Box::new(move |_| {
            events.borrow_mut().push("accepted".to_owned());
            Ok(())
        })));
        assert!(io.line().await.ends_with('\n'));
        io.outbound.write_all(concat!(
            "{\"type\":\"agent_settled\"}\n",
            "{\"type\":\"response\",\"id\":\"garcon-1\",\"command\":\"prompt\",\"success\":true}\r\n",
            "{\"type\":\"queue_update\",\"steering\":[\"a\u{2028}b\u{2029}c\"]}\n",
        ).as_bytes()).await.unwrap();

        assert!(pending.await.unwrap().success);
        assert_eq!(*io.events.borrow(), [
            r#"{"type":"agent_settled"}"#, "accepted", "{\"type\":\"queue_update\",\"steering\":[\"a\u{2028}b\u{2029}c\"]}",
        ]);
    }).await;
}

#[tokio::test]
async fn malformed_frames_and_a_failed_observer_do_not_stop_delivery() {
    LocalSet::new()
        .run_until(async {
            let mut io = Harness::new(1024);
            let pending = io.client.send_unbounded(
                command("prompt"),
                Some(Box::new(|_| Err("invalid disposition".into()))),
            );
            assert!(io.line().await.ends_with('\n'));
            io.outbound
                .write_all(b"not JSON\n[1,2,3]\n{\"type\":\"response\",\"id\":")
                .await
                .unwrap();
            io.outbound
                .write_all(b"\"garcon-1\",\"success\":true}\n{\"type\":\"agent_settled\"}\n")
                .await
                .unwrap();
            assert_eq!(
                pending.await.unwrap_err().to_string(),
                "invalid disposition"
            );
            assert_eq!(*io.malformed.borrow(), ["not JSON", "[1,2,3]"]);
            assert_eq!(*io.events.borrow(), [r#"{"type":"agent_settled"}"#]);
        })
        .await;
}

#[tokio::test]
async fn a_refused_command_preserves_the_provider_error() {
    LocalSet::new().run_until(async {
        let mut io = Harness::new(1024);
        let pending = io.client.send_unbounded(command("prompt"), None);
        assert!(io.line().await.ends_with('\n'));
        io.emit(&json!({"type":"response","id":"garcon-1","success":false,"error":"Pi refused the command"})).await;
        let error = pending.await.unwrap_err();
        let error = error.downcast_ref::<PiRpcCommandError>().unwrap();
        assert_eq!(error.command, "prompt");
        assert_eq!(error.to_string(), "Pi refused the command");
    }).await;
}

#[tokio::test(start_paused = true)]
async fn the_deadline_starts_after_writing_and_late_replies_are_ignored() {
    LocalSet::new()
        .run_until(async {
            let mut io = Harness::new(4);
            let request = io.client.send(command("get_state"), 20, None);
            tokio::pin!(request);
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(
                    request.as_mut().poll(cx).is_pending()
                ))
                .await
            );
            assert!(io.line().await.ends_with('\n'));
            let error = request.await.unwrap_err();
            let error = error.downcast_ref::<PiRpcTransportError>().unwrap();
            assert!(error.write_attempted);
            assert_eq!(
                error.to_string(),
                "Pi get_state response timed out after 20ms"
            );

            io.emit(&json!({"type":"response","id":"garcon-1","success":true}))
                .await;
            let next = io.client.send_unbounded(command("get_state"), None);
            assert!(io.line().await.ends_with('\n'));
            io.emit(&json!({"type":"response","id":"garcon-2","success":true}))
                .await;
            assert!(next.await.unwrap().success);
            assert!(io.events.borrow().is_empty());
        })
        .await;
}

#[tokio::test]
async fn process_exit_settles_queued_and_attempted_writes_distinctly() {
    LocalSet::new()
        .run_until(async {
            let mut io = Harness::new(4);
            let active = io.client.send_unbounded(command("get_state"), None);
            let queued = io.client.send_unbounded(command("get_state"), None);
            assert_eq!(io.inbound.read_u8().await.unwrap(), b'{');
            io.exit.send_replace(Some(143));
            for (failure, attempted) in [(active.await, true), (queued.await, false)] {
                let error = failure.unwrap_err();
                let error = error.downcast_ref::<PiRpcTransportError>().unwrap();
                assert_eq!(error.to_string(), "Pi process exited with code 143");
                assert_eq!(error.write_attempted, attempted);
            }
            assert_eq!(io.client.exited().await, Some(143));
            let error = io
                .client
                .send_unbounded(command("get_state"), None)
                .await
                .unwrap_err();
            let error = error.downcast_ref::<PiRpcTransportError>().unwrap();
            assert!(!error.write_attempted);
        })
        .await;
}
