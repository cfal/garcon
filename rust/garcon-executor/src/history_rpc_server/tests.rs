use async_trait::async_trait;
use futures::{stream, stream::LocalBoxStream};
use garcon_contract::chat_types::parse_chat_message;
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::execution_v5::{
    AgentExecutionHandle, AgentResumeRequestV5, AgentStartRequestV5,
};
use garcon_interface::native_history::AgentHistoryStream;
use garcon_interface::resources::{AgentInstanceCallOptions, ExecutorResult};
use garcon_js::json::Opaque;
use serde_json::json;
use tokio::task::LocalSet;
use tokio::time::timeout;

use super::*;

type Batch = ExecutorResult<Vec<AgentImportedTranscriptRow>>;

struct Import(Box<dyn Fn(AgentHistoryImportRequest) -> LocalBoxStream<'static, Batch>>);

impl AgentHistoryImport for Import {
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        _: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        (self.0)(request)
    }
}

#[derive(Default)]
struct Execution {
    release: RefCell<Option<oneshot::Receiver<Vec<AgentRunningSession>>>>,
    entered: Notify,
}

#[async_trait(?Send)]
impl AgentExecutionV5 for Execution {
    async fn start(
        &self,
        _: AgentStartRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        panic!("history must not start execution");
    }

    async fn resume(
        &self,
        _: AgentResumeRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        panic!("history must not resume execution");
    }

    async fn abort(
        &self,
        _: AgentExecutionHandle,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        panic!("history must not abort execution");
    }

    async fn running_sessions(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        let release = self.release.take();
        self.entered.notify_one();
        match release {
            Some(release) => Ok(release.await.unwrap()),
            None => Ok(Vec::new()),
        }
    }
}

struct Fixture {
    server: Rc<HistoryRpcServer>,
    scope: AgentResourceScope,
    execution: Execution,
    source: Rc<dyn AgentHistoryImport>,
}

impl Fixture {
    fn new(
        source: impl Fn(AgentHistoryImportRequest) -> LocalBoxStream<'static, Batch> + 'static,
    ) -> Rc<Self> {
        Rc::new(Self {
            server: Rc::default(),
            scope: AgentResourceScope {
                executor_id: "local".into(),
                instance_id: "instance".into(),
                integration_id: "test".into(),
            },
            execution: Execution::default(),
            source: Rc::new(Import(Box::new(source))),
        })
    }

    async fn call(&self, method: &str, request: Value) -> RpcResult {
        let call = ExecutorRpcRequest {
            id: "test-call".into(),
            seq: 1,
            integration_id: self.scope.integration_id.clone(),
            method: method.into(),
            request: Opaque::from_value(request),
        };
        self.server
            .handle(
                HistoryIntegration {
                    scope: &self.scope,
                    execution: &self.execution,
                    legacy: None,
                    native: Some(self.source.clone()),
                },
                &call,
                CancellationToken::new(),
            )
            .await
    }

    async fn open(&self) -> RpcResult {
        self.call(
            "history.open",
            json!({
                "source":"nativeHistoryImport",
                "request":{"chat":{
                    "chatId":"1000000000000001",
                    "agentId":"test",
                    "agentSessionId":"native-session",
                    "projectPath":"/project",
                    "model":"test-model",
                    "nativeSession":null,
                    "carryOverRevision":"revision",
                    "nativeSeedReceipt":null,
                    "settings":{"ownerId":"test","schemaVersion":1,"values":{}},
                }}
            }),
        )
        .await
    }
}

fn code(result: RpcResult) -> AgentIntegrationErrorCode {
    result
        .unwrap_err()
        .downcast_ref::<AgentCallError>()
        .unwrap()
        .code
}

struct Returned(Rc<Cell<usize>>);

impl Drop for Returned {
    fn drop(&mut self) {
        self.0.update(|returned| returned + 1);
    }
}

fn row(text: String) -> AgentImportedTranscriptRow {
    AgentImportedTranscriptRow {
        message: parse_chat_message(&json!({
            "type":"assistant-message", "timestamp":"2026-01-01T00:00:00Z", "content":text,
        }))
        .unwrap()
        .unwrap(),
        provider_meta: None,
    }
}

#[tokio::test]
async fn opening_held_in_running_sessions_cannot_register_after_bulk_closure() {
    LocalSet::new()
        .run_until(timeout(Duration::from_secs(5), async {
            let loads = Rc::new(Cell::new(0));
            let fixture = Fixture::new({
                let loads = loads.clone();
                move |_| {
                    loads.update(|count| count + 1);
                    stream::empty().boxed_local()
                }
            });
            let (release, waiting) = oneshot::channel();
            fixture.execution.release.replace(Some(waiting));
            let opening = tokio::task::spawn_local({
                let fixture = fixture.clone();
                async move { fixture.open().await }
            });
            fixture.execution.entered.notified().await;
            fixture.server.dispose();
            release.send(Vec::new()).unwrap();
            assert_eq!(
                code(opening.await.unwrap()),
                AgentIntegrationErrorCode::STALE_RESOURCE
            );
            assert_eq!(
                code(fixture.open().await),
                AgentIntegrationErrorCode::STALE_RESOURCE
            );
            assert_eq!(loads.get(), 0);
        }))
        .await
        .unwrap();
}

#[tokio::test]
async fn queued_pages_and_late_batches_do_not_advance_a_closed_reader() {
    LocalSet::new()
        .run_until(timeout(Duration::from_secs(5), async {
            let (release, waiting) = oneshot::channel();
            let entered = Rc::new(Notify::new());
            let reads = Rc::new(Cell::new(0));
            let returned = Rc::new(Cell::new(0));
            let fixture = Fixture::new({
                let entered = entered.clone();
                let reads = reads.clone();
                let returned = returned.clone();
                let waiting = RefCell::new(Some(waiting));
                move |request| {
                    let entered = entered.clone();
                    let reads = reads.clone();
                    let returned = Returned(returned.clone());
                    let waiting = waiting.take().unwrap();
                    stream::once(async move {
                        let _returned = returned;
                        reads.update(|count| count + 1);
                        entered.notify_one();
                        waiting.await.unwrap();
                        assert!(request.signal.is_cancelled());
                        Ok(vec![row("late synthetic row".into())])
                    })
                    .boxed_local()
                }
            });
            let reader = fixture.open().await.unwrap().unwrap();
            let mut pages = Vec::new();
            for page in 0..4 {
                let input = json!({ "reader": reader, "page": page });
                let fixture = fixture.clone();
                pages.push(tokio::task::spawn_local(async move {
                    fixture.call("history.next", input).await
                }));
                tokio::task::yield_now().await;
            }
            entered.notified().await;
            fixture.server.dispose();
            assert_eq!(returned.get(), 0);
            release.send(()).unwrap();
            for page in pages {
                assert_eq!(
                    code(page.await.unwrap()),
                    AgentIntegrationErrorCode::STALE_RESOURCE
                );
            }
            assert_eq!(reads.get(), 1);
            assert_eq!(returned.get(), 1);
        }))
        .await
        .unwrap();
}

#[tokio::test]
async fn closes_unread_streams_and_yields_a_row_larger_than_the_target_on_its_own() {
    LocalSet::new().run_until(timeout(Duration::from_secs(5), async {
        let returned = Rc::new(Cell::new(0));
        let fixture = Fixture::new({
            let returned = returned.clone();
            move |_| {
                let returned = Returned(returned.clone());
                stream::iter(std::iter::from_fn(move || {
                    let _returned = &returned;
                    panic!("history close polled an unopened stream")
                })).boxed_local()
            }
        });
        let reader = fixture.open().await.unwrap().unwrap();
        let wire = serde_json::to_string(&reader).unwrap();
        assert!(wire.starts_with(r#"{"executorId":"local","instanceId":"instance","integrationId":"test","kind":"history-reader","id":"#));
        assert!(fixture.call("history.close", reader.into_value()).await.unwrap().is_none());
        assert_eq!(returned.get(), 1);

        let fixture = Fixture::new(|_| stream::iter([
            Ok(vec![row("x".repeat(1200 * 1024)), row("second".into())]),
        ]).boxed_local());
        let reader = fixture.open().await.unwrap().unwrap();
        let out_of_order = fixture.call("history.next", json!({"reader":reader,"page":1})).await.unwrap_err();
        assert_eq!(out_of_order.to_string(), "History pages must be requested in order");
        for (page, text) in [(0, "x".repeat(1200 * 1024)), (1, "second".to_owned())] {
            let response = fixture.call("history.next", json!({"reader":reader,"page":page})).await.unwrap().unwrap();
            assert_eq!(response["done"], false);
            assert_eq!(response["rows"].as_array().unwrap().len(), 1);
            assert_eq!(response["rows"][0]["message"]["content"], text);
        }
        let end = fixture.call("history.next", json!({"reader":reader,"page":2})).await.unwrap().unwrap();
        assert_eq!(*end, json!({"done":true,"rows":[]}));
        fixture.server.dispose();
    })).await.unwrap();
}
