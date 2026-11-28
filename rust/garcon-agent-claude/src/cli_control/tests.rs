use std::cell::Cell;

use serde_json::json;
use tokio::task::LocalSet;

use super::*;

fn broker(write: Rc<ControlWriter>) -> ClaudeControlBroker {
    let sequence = Cell::new(0);
    ClaudeControlBroker::with_request_ids(write, move || {
        sequence.set(sequence.get() + 1);
        format!("synthetic-request-{}", sequence.get())
    })
}

fn written() -> Rc<ControlWriter> {
    Rc::new(|_, _| Box::pin(async { Ok(()) }))
}

fn reply(id: u64, subtype: &str, result: Value) -> Value {
    json!({ "type": "control_response", "response": { "request_id": format!("synthetic-request-{id}"), "subtype": subtype, "response": result } })
}

#[tokio::test]
async fn correlates_success_error_and_invalid_subtypes_without_crossing_sessions() {
    LocalSet::new().run_until(async {
        let frames = Rc::new(RefCell::new(Vec::new()));
        let capture = frames.clone();
        let broker = broker(Rc::new(move |session, frame| {
            capture.borrow_mut().push((session, frame));
            Box::pin(async { Ok(()) })
        }));
        let pending = broker.request("session-1", json!({ "subtype": "initialize", "arguments": [1.0] }).into(), Default::default());
        assert_eq!(frames.borrow()[0], ("session-1".to_owned(), r#"{"type":"control_request","request_id":"synthetic-request-1","request":{"subtype":"initialize","arguments":[1]}}"#.to_owned()));
        let result = reply(1, "success", json!({ "ready": true }));
        assert!(!broker.handle_response("other-session", &result));
        assert!(broker.handle_response("session-1", &result));
        assert_eq!(pending.await.unwrap().into_value(), json!({ "ready": true }));
        assert!(!broker.handle_response("session-1", &result));

        let pending = broker.request("session-1", json!({ "subtype": "set_model" }).into(), Default::default());
        let response = json!({ "response": { "request_id": "synthetic-request-2", "subtype": "error", "error": "synthetic failure" } });
        assert!(broker.handle_response("session-1", &response));
        assert_eq!(pending.await.unwrap_err().to_string(), "synthetic failure");

        let pending = broker.request("session-1", json!({ "subtype": "interrupt" }).into(), Default::default());
        assert!(broker.handle_response("session-1", &reply(3, "future-subtype", Value::Null)));
        assert_eq!(pending.await.unwrap_err().to_string(), "Claude CLI interrupt control request returned an invalid response");

        let pending = broker.request("session-1", json!({ "subtype": "initialize" }).into(), Default::default());
        assert!(broker.handle_response("session-1", &reply(4, "success", Value::Null)));
        assert_eq!(pending.await.unwrap().into_value(), json!({}));
    }).await;
}

#[tokio::test(start_paused = true)]
async fn rejects_timeouts_failed_writes_process_exits_and_shutdown() {
    LocalSet::new()
        .run_until(async {
            let failed = broker(Rc::new(|_, _| {
                Box::pin(async { Err("synthetic write failure".into()) })
            }));
            let pending = failed.request(
                "session-1",
                json!({ "subtype": "initialize" }).into(),
                Default::default(),
            );
            assert_eq!(
                pending.await.unwrap_err().to_string(),
                "synthetic write failure"
            );
            let broker = broker(written());
            let pending = broker.request(
                "session-1",
                json!({ "subtype": "initialize" }).into(),
                ClaudeControlRequestOptions {
                    timeout: Some(Duration::from_secs(1)),
                    ..Default::default()
                },
            );
            tokio::time::advance(Duration::from_secs(1)).await;
            assert_eq!(
                pending.await.unwrap_err().to_string(),
                "Claude CLI initialize control request timed out"
            );
            let session = broker.request(
                "session-1",
                json!({ "subtype": "interrupt" }).into(),
                Default::default(),
            );
            let other_subtype = broker.request(
                "session-1",
                json!({ "subtype": "set_model" }).into(),
                Default::default(),
            );
            let other_session = broker.request(
                "session-2",
                json!({ "subtype": "interrupt" }).into(),
                Default::default(),
            );
            broker.reject_session("session-1", "process exited", Some("interrupt"));
            assert_eq!(session.await.unwrap_err().to_string(), "process exited");
            broker.shutdown("runtime shut down");
            assert_eq!(
                other_subtype.await.unwrap_err().to_string(),
                "runtime shut down"
            );
            assert_eq!(
                other_session.await.unwrap_err().to_string(),
                "runtime shut down"
            );
        })
        .await;
}

#[tokio::test]
async fn removes_a_cancelled_request_before_accepting_a_late_reply() {
    LocalSet::new()
        .run_until(async {
            let broker = broker(written());
            let signal = CancellationToken::new();
            let pending = broker.request(
                "session-1",
                json!({ "subtype": "interrupt" }).into(),
                ClaudeControlRequestOptions {
                    signal: Some(signal.clone()),
                    cancellation_error: Some(Rc::new(|| "turn already cancelled".into())),
                    ..Default::default()
                },
            );
            signal.cancel();
            assert!(!broker.handle_response("session-1", &reply(1, "success", json!({}))));
            assert_eq!(
                pending.await.unwrap_err().to_string(),
                "turn already cancelled"
            );
        })
        .await;
}
