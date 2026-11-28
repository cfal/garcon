use super::*;
use crate::direct::test_runtime::{
    Capture, SESSION_ID, endpoint, execution_request, native_session, router,
};
use garcon_contract::chat_modes::ThinkingMode;
use tokio_util::sync::CancellationToken;

fn start_request(endpoint: DirectEndpointRuntime) -> DirectStartRequest {
    DirectStartRequest {
        execution: execution_request(endpoint),
        on_session_activated: None,
    }
}

#[tokio::test]
async fn rejects_a_different_endpoint_protocol_before_creating_a_runtime() {
    let trace = Rc::new(Capture::default());
    let router = router(trace.clone());
    let rejected = || {
        let mut endpoint = endpoint("a");
        endpoint.selection.protocol = ApiProtocol::AnthropicMessages;
        endpoint
    };
    let rejection = router
        .start_session(start_request(rejected()))
        .await
        .err()
        .unwrap();
    assert_eq!(
        rejection.to_string(),
        "Direct fixture does not support anthropic-messages endpoints"
    );
    let rejection = router
        .run_single_query(
            "continue".into(),
            rejected(),
            DirectSingleQueryOptions {
                model: "model".into(),
                thinking_mode: ThinkingMode::None,
                timeout_ms: None,
                signal: CancellationToken::new(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        rejection.to_string(),
        "Direct fixture does not support anthropic-messages endpoints"
    );
    assert!(trace.calls.borrow().is_empty());
}

#[tokio::test]
async fn starts_purge_timers_for_existing_and_newly_created_endpoint_runtimes() {
    let trace = Rc::new(Capture::default());
    let router = router(trace.clone());
    router
        .start_session(start_request(endpoint("a")))
        .await
        .unwrap();
    router.start_purge_timer();
    router
        .start_session(start_request(endpoint("b")))
        .await
        .unwrap();
    router.start_purge_timer();
    router.shutdown();
    assert_eq!(
        *trace.calls.borrow(),
        [
            "a:create",
            "a:start",
            "a:purge",
            "b:create",
            "b:purge",
            "b:start",
            "a:shutdown",
            "b:shutdown"
        ]
    );
}

#[tokio::test]
async fn rehydrates_a_session_whenever_its_endpoint_route_or_credential_changes() {
    let trace = Rc::new(Capture::default());
    let router = router(trace.clone());
    let mut second = endpoint("b");
    second.credential = Some("synthetic".into());
    let started = router
        .start_session(start_request(endpoint("a")))
        .await
        .unwrap();
    assert_eq!(started.agent_session_id, SESSION_ID);
    for endpoint in [second, endpoint("a")] {
        router
            .run_turn(DirectResumeRequest {
                execution: execution_request(endpoint),
                agent_session_id: SESSION_ID.into(),
                native_session: Some(native_session()),
            })
            .await
            .unwrap();
    }
    assert_eq!(
        *trace.calls.borrow(),
        [
            "a:create", "a:start", "a:forget", "b:create", "b:resume", "b:forget", "a:resume"
        ]
    );
    assert!(
        trace
            .resumes
            .borrow()
            .iter()
            .all(|request| request.native_session.as_ref() == Some(&native_session()))
    );
}
