use std::{cell::RefCell, collections::VecDeque};

use async_trait::async_trait;
use garcon_js::ManualClock;
use indexmap::IndexMap;

use super::{
    super::{sdk_client::OpenCodeEnvelopes, sdk_result::OpenCodeSdkResult},
    *,
};

struct Silent;

impl AgentLogger for Silent {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

struct Responses {
    requests: RefCell<Vec<(OpenCodeRequest, Map<String, Value>)>>,
    results: RefCell<VecDeque<OpenCodeSdkResult>>,
    cancel_get: bool,
}

impl Responses {
    fn new<const N: usize>(results: [OpenCodeSdkResult; N]) -> Self {
        Self {
            requests: RefCell::default(),
            results: RefCell::new(results.into()),
            cancel_get: false,
        }
    }
}

#[async_trait(?Send)]
impl OpenCodeClient for Responses {
    async fn request(
        &self,
        request: OpenCodeRequest,
        params: Map<String, Value>,
        signal: &AbortSignal,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        self.requests.borrow_mut().push((request, params));
        if self.cancel_get && request == OpenCodeRequest::SessionGet {
            signal.abort(crate::js::shared_error(
                "AbortError",
                "scope read cancelled",
            ));
        }
        Ok(self
            .results
            .borrow_mut()
            .pop_front()
            .expect("fixture response"))
    }

    async fn global_events(&self, _: &AbortSignal) -> ExecutorResult<OpenCodeEnvelopes> {
        unreachable!()
    }
    fn supports_config_providers(&self) -> bool {
        false
    }
    fn supports_move_session(&self) -> bool {
        false
    }
}

fn options(signal: &AbortSignal) -> HistoryLoadOptions<'_> {
    HistoryLoadOptions {
        directory: Some("/repo/a"),
        signal,
        throw_on_error: true,
        logger: &Silent,
        limit: None,
    }
}

#[tokio::test]
async fn validates_the_directory_before_reading_native_messages() {
    let signal = AbortSignal::new();
    let client = Responses::new([OpenCodeSdkResult::success(
        json!({"directory": "/repo/b"}),
        200,
    )]);
    let failure = load_required_open_code_chat_messages(
        Some("session"),
        &client,
        &options(&signal),
        &ManualClock::new(0),
    )
    .await
    .unwrap_err();
    assert!(failure.is::<OpenCodeTranscriptNotFoundError>());
    assert_eq!(
        *client.requests.borrow(),
        [(
            OpenCodeRequest::SessionGet,
            Map::from_iter([
                ("sessionID".to_owned(), json!("session")),
                ("directory".to_owned(), json!("/repo/a"))
            ]),
        )]
    );
}

#[tokio::test]
async fn rejects_bad_stored_parts_and_can_reload_the_same_source_after_repair() {
    let signal = AbortSignal::new();
    let session = OpenCodeSdkResult::success(json!({"directory": "/repo/a/."}), 200);
    let valid = json!({"info": {"id": "u", "role": "user", "time": {"created": 0}}, "parts": [{"type": "text", "text": "prompt"}]});
    let invalid =
        json!({"info": {"id": "u", "role": "user"}, "parts": [{"type": "text", "text": 42}]});
    let client = Responses::new([
        session.clone(),
        OpenCodeSdkResult::success(json!([valid, invalid]), 200),
        session,
        OpenCodeSdkResult::success(json!([valid]), 200),
    ]);
    let reload = || async {
        load_required_open_code_chat_messages(
            Some("session"),
            &client,
            &options(&signal),
            &ManualClock::new(0),
        )
        .await
    };
    assert_eq!(
        reload().await.unwrap_err().to_string(),
        "OpenCode stored transcript part is invalid"
    );
    assert!(
        matches!(reload().await.unwrap().as_slice(), [row] if matches!(&row.value, ChatMessage::User(user) if user.content == "prompt"))
    );
    assert!(
        client
            .requests
            .borrow()
            .iter()
            .all(|(_, params)| prop(params, "directory") == "/repo/a")
    );
}

#[tokio::test]
async fn cancellation_wins_over_errors_on_the_scoped_get() {
    let signal = AbortSignal::new();
    let mut client = Responses::new([OpenCodeSdkResult::failure(
        json!({"message": "server failed"}),
        500,
    )]);
    client.cancel_get = true;
    let failure = load_required_open_code_chat_messages(
        Some("session"),
        &client,
        &options(&signal),
        &ManualClock::new(0),
    )
    .await
    .unwrap_err();
    assert_eq!(failure.to_string(), "scope read cancelled");
    assert_eq!(client.requests.borrow().len(), 1);
}
