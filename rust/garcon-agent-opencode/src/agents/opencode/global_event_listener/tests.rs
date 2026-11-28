use std::time::Duration;

use async_trait::async_trait;
use garcon_js::json::Opaque;
use serde_json::{Map, Value};
use tokio::{sync::mpsc, task::LocalSet, time::advance};

use super::*;
use crate::agents::opencode::{
    sdk_client::{OpenCodeEnvelopes, OpenCodeRequest},
    sdk_result::OpenCodeSdkResult,
};

struct FakeClient(RefCell<Option<mpsc::UnboundedReceiver<Value>>>);

#[async_trait(?Send)]
impl OpenCodeClient for FakeClient {
    async fn request(
        &self,
        _: OpenCodeRequest,
        _: Map<String, Value>,
        _: &AbortSignal,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        Err(error("Error", "Unexpected SDK request"))
    }

    async fn global_events(&self, _: &AbortSignal) -> ExecutorResult<OpenCodeEnvelopes> {
        let stream = self
            .0
            .take()
            .ok_or_else(|| error("Error", "Unexpected second global stream"))?;
        Ok(futures::stream::unfold(stream, |mut stream| async move {
            stream.recv().await.map(|event| (Ok(event), stream))
        })
        .boxed_local())
    }

    fn supports_config_providers(&self) -> bool {
        false
    }

    fn supports_move_session(&self) -> bool {
        false
    }
}

struct Logger;

impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

fn stream() -> (Rc<dyn OpenCodeClient>, mpsc::UnboundedSender<Value>) {
    let (send, receive) = mpsc::unbounded_channel();
    (Rc::new(FakeClient(RefCell::new(Some(receive)))), send)
}

fn event(kind: &str) -> Value {
    json!({ "payload": { "type": kind } })
}

fn options(get_client: GetClient) -> OpenCodeGlobalEventListenerOptions {
    OpenCodeGlobalEventListenerOptions {
        request_timeout_ms: 1_000.0,
        heartbeat_timeout_ms: 1_000.0,
        retry_delay_ms: 1_000.0,
        logger: Rc::new(Logger),
        get_client,
        is_shutting_down: Rc::new(|| false),
        is_temporarily_unavailable: Rc::new(|| false),
        unavailable_retry_after_ms: Rc::new(|| 0.0),
        instance_generation: None,
        mark_temporarily_unavailable: Rc::new(|_, _| false),
        fail_running_turns: Rc::new(|_| {}),
        close_unavailable_instance_if_idle: Rc::new(|| false),
        confirm_event_delivery: Rc::new(|_| async { Ok(()) }.boxed_local()),
        handle_event: Rc::new(|_, _| Ok(())),
    }
}

fn get_client(client: Rc<dyn OpenCodeClient>) -> GetClient {
    Rc::new(move || {
        let client = client.clone();
        async { Ok(client) }.boxed_local()
    })
}

#[tokio::test(start_paused = true)]
async fn waits_for_provider_event_delivery_confirmation_after_server_connected() {
    LocalSet::new().run_until(async {
        let (client, provider) = stream();
        let (confirming, confirmation_started) = oneshot::channel();
        let confirming = RefCell::new(Some(confirming));
        let listener = OpenCodeGlobalEventListener::new(OpenCodeGlobalEventListenerOptions {
            confirm_event_delivery: Rc::new(move |input| {
                let barrier = (input.wait_for_event)(Rc::new(|event| event.kind == "tui.toast.show" && event.property("message") == "readiness-confirmed"), Some(input.signal));
                confirming.take().expect("confirmation starts once").send(input.directory).expect("confirmation observer");
                async { barrier.await.map(|_| ()) }.boxed_local()
            }),
            ..options(get_client(client))
        });
        let mut starting = listener.start(Some("/repo".to_owned()));
        provider.send(event("server.connected")).expect("connected marker");
        assert_eq!(confirmation_started.await.expect("confirmation barrier"), Some("/repo".to_owned()));
        assert!(futures::poll!(&mut starting).is_pending());
        provider.send(json!({"payload":{"type":"tui.toast.show","properties":{"message":"readiness-confirmed"}}})).expect("confirm delivery");
        starting.await.expect("ready after confirmation");

        let cancel = AbortSignal::new();
        let cancelled = listener.wait_for_event(Rc::new(|event| event.kind == "test.barrier"), Some(cancel.clone()));
        let survivor = listener.wait_for_event(Rc::new(|event| event.kind == "test.barrier"), None);
        cancel.abort(shared_error("Error", "barrier cancelled"));
        assert_eq!(cancelled.await.expect_err("cancelled waiter").to_string(), "barrier cancelled");
        provider.send(event("test.barrier")).expect("signal survivor");
        assert_eq!(survivor.await.expect("surviving waiter").kind, "test.barrier");
        listener.close();
    }).await;
}

#[tokio::test(start_paused = true)]
async fn does_not_reject_replacement_generation_waiters_when_the_old_stream_retires() {
    LocalSet::new()
        .run_until(async {
            let (old_client, _old_provider) = stream();
            let (replacement, provider) = stream();
            let (old_started, old_starting) = oneshot::channel::<()>();
            let (retire_old, retire) = oneshot::channel::<()>();
            let (old_returned, old_return) = oneshot::channel::<()>();
            let old = RefCell::new(Some(
                async move {
                    old_started.send(()).expect("old attempt entered");
                    retire.await?;
                    old_returned.send(()).expect("old client returned");
                    Ok(old_client)
                }
                .boxed_local(),
            ));
            let listener = OpenCodeGlobalEventListener::new(options(Rc::new(move || {
                old.take()
                    .unwrap_or_else(|| get_client(replacement.clone())())
            })));
            let first = listener.start(Some("/repo".to_owned()));
            old_starting
                .await
                .expect("old attempt is blocked in get_client");
            listener.close();
            assert_eq!(
                first.await.expect_err("closed startup").to_string(),
                "OpenCode event listener closed before it was ready"
            );
            let current_start = listener.start(None);
            provider
                .send(event("server.connected"))
                .expect("replacement connected");
            current_start.await.expect("replacement ready");
            let waiter = listener.wait_for_event(
                Rc::new(|event| event.kind == "test.replacement-barrier"),
                None,
            );

            retire_old.send(()).expect("release the old attempt");
            old_return.await.expect("old attempt left get_client");
            provider
                .send(event("test.replacement-barrier"))
                .expect("replacement event");
            assert_eq!(
                waiter.await.expect("replacement waiter still live").kind,
                "test.replacement-barrier"
            );
            listener.close();
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn heartbeat_timeout_fails_turns_once_against_the_connected_instance_generation() {
    LocalSet::new()
        .run_until(async {
            let (client, provider) = stream();
            let (availability, mut marked) = mpsc::unbounded_channel();
            let (failures, mut failed) = mpsc::unbounded_channel();
            let listener = OpenCodeGlobalEventListener::new(OpenCodeGlobalEventListenerOptions {
                request_timeout_ms: 10.0,
                heartbeat_timeout_ms: 40.0,
                instance_generation: Some(Rc::new(|| 17)),
                mark_temporarily_unavailable: Rc::new(move |reason, generation| {
                    availability
                        .send((reason, generation))
                        .expect("mark unavailable");
                    true
                }),
                fail_running_turns: Rc::new(move |failure| {
                    failures.send(failure.to_string()).expect("turn failure")
                }),
                ..options(get_client(client))
            });
            let starting = listener.start(None);
            provider
                .send(event("server.connected"))
                .expect("connected marker");
            starting.await.expect("ready");
            advance(Duration::from_millis(39)).await;
            assert!(failed.try_recv().is_err());
            advance(Duration::from_millis(1)).await;
            let expected = "OpenCode event stream heartbeat timed out after 40ms";
            assert_eq!(
                marked.recv().await.expect("unavailability"),
                (expected.to_owned(), Some(17))
            );
            assert_eq!(failed.recv().await.as_deref(), Some(expected));
            listener.close();
            assert!(failed.try_recv().is_err());
        })
        .await;
}
