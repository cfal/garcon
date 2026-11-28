use async_trait::async_trait;
use futures::{StreamExt, stream};
use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::execution::AgentExecutionAdmission;
use garcon_js::clock::ManualClock;
use tokio::{sync::mpsc, task::LocalSet};
use tokio_util::sync::CancellationToken;

use super::{
    super::{
        instance_lifecycle::OpenCodeServer,
        runtime_types::{OpenCodeExecutionRequest, OpenCodeResumeRequest, OpenCodeStartRequest},
        sdk_client::OpenCodeEnvelopes,
    },
    *,
};

struct Client {
    requests: mpsc::UnboundedSender<OpenCodeRequest>,
    permission_reply: bool,
    create: RefCell<Option<oneshot::Receiver<Value>>>,
    prompt: RefCell<Option<Value>>,
    prompt_parameters: RefCell<Option<Map<String, Value>>>,
}

#[async_trait(?Send)]
impl OpenCodeClient for Client {
    async fn request(
        &self,
        operation: OpenCodeRequest,
        parameters: Map<String, Value>,
        signal: &AbortSignal,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        let _ = self.requests.send(operation);
        if operation == OpenCodeRequest::SessionPrompt {
            self.prompt_parameters.replace(Some(parameters));
            if let Some(response) = self.prompt.take() {
                return Ok(OpenCodeSdkResult::success(response, 200));
            }
            signal.token().cancelled().await;
            return Err(signal.abort_reason().into());
        }
        if operation == OpenCodeRequest::SessionCreate
            && let Some(receive) = self.create.take()
        {
            return Ok(OpenCodeSdkResult::success(receive.await?, 200));
        }
        Ok(OpenCodeSdkResult::success(
            match operation {
                OpenCodeRequest::SessionCreate => json!({"id": "new-session"}),
                _ => json!(true),
            },
            200,
        ))
    }

    async fn global_events(&self, _: &AbortSignal) -> ExecutorResult<OpenCodeEnvelopes> {
        Ok(stream::iter([Ok(
            json!({"payload":{"type":"server.connected","properties":{}}}),
        )])
        .chain(stream::pending())
        .boxed_local())
    }

    fn supports_config_providers(&self) -> bool {
        false
    }
    fn supports_move_session(&self) -> bool {
        false
    }
    fn supports_permission_reply(&self) -> bool {
        self.permission_reply
    }
}

struct InstanceFixture {
    instance: Rc<OpenCodeInstance>,
    client: Rc<Client>,
    terminate: oneshot::Sender<()>,
    observed: oneshot::Receiver<()>,
    closed: Rc<Cell<u32>>,
    requests: mpsc::UnboundedReceiver<OpenCodeRequest>,
}

impl InstanceFixture {
    fn new(permission_reply: bool) -> Self {
        let (requests, receive_requests) = mpsc::unbounded_channel();
        let client = Rc::new(Client {
            requests,
            permission_reply,
            create: RefCell::new(None),
            prompt: RefCell::new(None),
            prompt_parameters: RefCell::new(None),
        });
        let (terminate, receive) = oneshot::channel();
        let (observed, wait_observed) = oneshot::channel();
        let exited = Rc::new(Cell::new(false));
        let closed = Rc::new(Cell::new(0));
        let termination = {
            let exited = exited.clone();
            async move {
                let _ = receive.await;
                exited.set(true);
                let _ = observed.send(());
                OpenCodeServerTermination::Exit {
                    code: Some(17),
                    signal: None,
                }
            }
            .boxed_local()
            .shared()
        };
        let server = OpenCodeServer {
            close: Some(Rc::new({
                let closed = closed.clone();
                move || {
                    closed.set(closed.get() + 1);
                    Ok(())
                }
            })),
            termination: Some(termination),
            exit_observed: Some(Rc::new(move || exited.get())),
        };
        let instance = Rc::new(OpenCodeInstance {
            client: client.clone(),
            base_url: None,
            server: Some(server),
            close: None,
        });
        Self {
            instance,
            client,
            terminate,
            observed: wait_observed,
            closed,
            requests: receive_requests,
        }
    }

    async fn exit(self, runtime: &OpenCodeRuntime) -> mpsc::UnboundedReceiver<OpenCodeRequest> {
        self.terminate.send(()).unwrap();
        self.observed.await.unwrap();
        runtime
            .endpoint
            .run_transition(|| async { Ok(()) })
            .await
            .unwrap();
        self.requests
    }
}

fn runtime(fixtures: &[&InstanceFixture]) -> Rc<OpenCodeRuntime> {
    let instances = RefCell::new(
        fixtures
            .iter()
            .rev()
            .map(|fixture| fixture.instance.clone())
            .collect::<Vec<_>>(),
    );
    OpenCodeRuntime::new(OpenCodeRuntimeOptions {
        clock: Some(Rc::new(ManualClock::new(1000))),
        request_timeout_ms: Some(1000.0),
        startup_timeout_ms: Some(1000.0),
        unavailable_retry_ms: Some(1000.0),
        sse_heartbeat_timeout_ms: Some(1000.0),
        sse_retry_delay_ms: Some(100.0),
        create_instance: Some(Rc::new(move |_| {
            let instance = instances.borrow_mut().pop();
            async move { instance.ok_or_else(|| error("Error", "unexpected spawn")) }.boxed_local()
        })),
        ..Default::default()
    })
}

fn request(publish: impl Fn(AgentRuntimeEvent) + 'static) -> OpenCodeStartRequest {
    OpenCodeStartRequest {
        command: "hello".to_owned(),
        images: vec![],
        on_session_activated: None,
        execution: OpenCodeExecutionRequest {
            chat_id: "chat".to_owned(),
            project_path: "/project".to_owned(),
            model: None,
            permission_mode: PermissionMode::Default,
            thinking_mode: None,
            execution_admission: None,
            operation: AgentRuntimeOperation {
                run_id: "run".to_owned(),
                publish: Rc::new(publish),
            },
        },
    }
}

struct Admission {
    signal: CancellationToken,
    entered: RefCell<Option<oneshot::Sender<()>>>,
    resume: RefCell<Option<oneshot::Receiver<()>>>,
}

#[async_trait(?Send)]
impl AgentExecutionAdmission for Admission {
    fn signal(&self) -> &CancellationToken {
        &self.signal
    }

    async fn mark_started(&self) -> ExecutorResult<()> {
        self.entered.take().unwrap().send(()).unwrap();
        let resume = self.resume.take().unwrap();
        resume.await?;
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn process_death_fails_waiters_once_and_fences_late_activation() {
    LocalSet::new()
        .run_until(async {
            let mut first = InstanceFixture::new(true);
            let mut replacement = InstanceFixture::new(true);
            let runtime = runtime(&[&first, &replacement]);
            let failures = Rc::new(RefCell::new(Vec::new()));
            let resume = OpenCodeResumeRequest {
                agent_session_id: "running".to_owned(),
                start: request({
                    let failures = failures.clone();
                    move |event| {
                        if let AgentRuntimeEvent::RunEnded {
                            outcome: ProviderRunOutcome::Failed { error: Some(error) },
                            ..
                        } = event
                        {
                            failures.borrow_mut().push(error.message);
                        }
                    }
                }),
            };
            let waiting_turn = spawn_local({
                let runtime = runtime.clone();
                async move { runtime.run_turn(resume).await }
            });
            assert_eq!(
                first.requests.recv().await,
                Some(OpenCodeRequest::SessionPrompt)
            );
            let (entered, wait_entered) = oneshot::channel();
            let (release, wait_release) = oneshot::channel();
            let activations = Rc::new(Cell::new(0));
            let mut start = request(|_| {});
            start.execution.execution_admission = Some(Rc::new(Admission {
                signal: CancellationToken::new(),
                entered: RefCell::new(Some(entered)),
                resume: RefCell::new(Some(wait_release)),
            }));
            start.on_session_activated = Some(Rc::new({
                let activations = activations.clone();
                move |_| activations.set(activations.get() + 1)
            }));
            let admission = spawn_local({
                let runtime = runtime.clone();
                async move { runtime.start_session(start).await }
            });
            wait_entered.await.unwrap();
            assert_eq!(
                first.requests.recv().await,
                Some(OpenCodeRequest::SessionCreate)
            );
            assert!(runtime.mark_temporarily_unavailable(
                "request timed out".to_owned(),
                Some(runtime.generation.get())
            ));
            let mut retired_requests = first.exit(&runtime).await;
            assert!(!runtime.is_temporarily_unavailable());
            assert!(runtime.get_client_if_initialized().is_none());
            assert!(!runtime.is_running("running"));
            assert!(
                !runtime
                    .session("running")
                    .unwrap()
                    .borrow()
                    .provider_work_requires_quiescence
            );
            let message = "OpenCode server process terminated unexpectedly (code 17)";
            assert_eq!(
                waiting_turn.await.unwrap().unwrap_err().to_string(),
                message
            );
            assert_eq!(*failures.borrow(), vec![Some(message.to_owned())]);

            release.send(()).unwrap();
            assert_eq!(
                admission.await.unwrap().unwrap_err().to_string(),
                "OpenCode server process was retired while the request was in flight"
            );
            assert_eq!(activations.get(), 0);
            assert!(runtime.session("new-session").is_none());
            assert!(retired_requests.try_recv().is_err());

            assert!(Rc::ptr_eq(
                &runtime.get_client().await.unwrap(),
                &replacement.instance.client
            ));
            assert_eq!(
                replacement.requests.recv().await,
                Some(OpenCodeRequest::SessionDelete)
            );
            assert_eq!(*failures.borrow(), vec![Some(message.to_owned())]);
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn deliberately_closed_process_exit_preserves_cooldown() {
    LocalSet::new()
        .run_until(async {
            let first = InstanceFixture::new(true);
            let closed = first.closed.clone();
            let runtime = runtime(&[&first]);
            runtime.get_client().await.unwrap();
            assert!(runtime.mark_temporarily_unavailable("request timed out".to_owned(), None));
            assert_eq!(closed.get(), 1);
            first.exit(&runtime).await;
            assert!(runtime.is_temporarily_unavailable());
            assert_eq!(runtime.unavailable_reason(), "request timed out");
            assert!(runtime.get_client().await.is_err());
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn late_session_create_is_retained_for_cleanup_without_publication() {
    LocalSet::new()
        .run_until(async {
            let mut first = InstanceFixture::new(true);
            let mut replacement = InstanceFixture::new(true);
            let runtime = runtime(&[&first, &replacement]);
            let (created, wait_created) = oneshot::channel();
            first.client.create.replace(Some(wait_created));
            let publications = Rc::new(Cell::new(0));
            let start = request({
                let publications = publications.clone();
                move |_| publications.set(publications.get() + 1)
            });
            let admission = spawn_local({
                let runtime = runtime.clone();
                async move { runtime.start_session(start).await }
            });
            assert_eq!(
                first.requests.recv().await,
                Some(OpenCodeRequest::SessionCreate)
            );
            let mut retired_requests = first.exit(&runtime).await;
            created.send(json!({"id": "late-session"})).unwrap();
            assert_eq!(
                admission.await.unwrap().unwrap_err().to_string(),
                "OpenCode server process was retired while the request was in flight",
            );
            assert_eq!(publications.get(), 0);
            assert!(runtime.session("late-session").is_none());
            assert!(runtime.get_client_if_initialized().is_none());
            assert!(retired_requests.try_recv().is_err());
            runtime.get_client().await.unwrap();
            assert_eq!(
                replacement.requests.recv().await,
                Some(OpenCodeRequest::SessionDelete)
            );
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn prompt_response_publishes_rows_before_its_terminal_and_retires_its_route() {
    LocalSet::new().run_until(async {
        let first = InstanceFixture::new(true);
        let runtime = runtime(&[&first]);
        first.client.prompt.replace(Some(json!({
            "info": {"id": "reply", "parentID": "input", "role": "assistant", "finish": "stop", "time": {"completed": 1000}},
            "parts": [{"id": "text", "messageID": "reply", "type": "text", "text": "answer"}],
        })));
        let output = Rc::new(RefCell::new(Vec::new()));
        let resume = OpenCodeResumeRequest { agent_session_id: "existing".to_owned(), start: request({
            let output = output.clone();
            move |event| output.borrow_mut().push(event)
        }) };
        runtime.run_turn(resume).await.unwrap();
        let events = output.take();
        assert!(matches!(events.as_slice(), [
            AgentRuntimeEvent::Rows { rows },
            AgentRuntimeEvent::RunEnded { outcome: ProviderRunOutcome::Finished { final_response: Some(AgentFinalResponse::Text { text }) }, .. }
        ] if rows.len() == 1 && text == "answer"));
        assert!(runtime.routes.idle());
        assert!(!runtime.is_running("existing"));
        runtime.shutdown().await;
    }).await;
}

#[tokio::test(start_paused = true)]
async fn one_shot_fences_a_created_session_on_process_death() {
    LocalSet::new()
        .run_until(async {
            let mut first = InstanceFixture::new(true);
            let mut replacement = InstanceFixture::new(true);
            let runtime = runtime(&[&first, &replacement]);
            let (created, wait_created) = oneshot::channel();
            first.client.create.replace(Some(wait_created));
            let query = spawn_local({
                let runtime = runtime.clone();
                async move {
                    runtime
                        .run_single_query(super::single_query::OpenCodeSingleQueryRequest {
                            prompt: "hello".to_owned(),
                            project_path: "/query".to_owned(),
                            model: String::new(),
                            permission_mode: "default".to_owned(),
                            thinking_mode: garcon_contract::chat_modes::ThinkingMode::None,
                            timeout_ms: None,
                            signal: AbortSignal::new(),
                        })
                        .await
                }
            });
            assert_eq!(
                first.requests.recv().await,
                Some(OpenCodeRequest::SessionCreate)
            );
            let mut retired = first.exit(&runtime).await;
            created.send(json!({"id": "one-shot-session"})).unwrap();
            assert_eq!(
                query.await.unwrap().unwrap_err().to_string(),
                "OpenCode server process was retired while the request was in flight"
            );
            assert!(retired.try_recv().is_err());
            runtime.get_client().await.unwrap();
            assert_eq!(
                replacement.requests.recv().await,
                Some(OpenCodeRequest::SessionDelete)
            );
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn one_shot_disables_tools_resolves_effort_and_deletes_its_session() {
    use garcon_contract::chat_modes::ThinkingMode;

    LocalSet::new()
        .run_until(async {
            let mut instance = InstanceFixture::new(true);
            let runtime = runtime(&[&instance]);
            for (mode, variant) in [
                (ThinkingMode::None, None),
                (ThinkingMode::Xhigh, Some("xhigh")),
            ] {
                instance.client.prompt.replace(Some(json!({"parts": [
                    {"type":"reasoning","text":"not a reply"},
                    {"type":"text","text":" hello "},
                    {"type":"text","text":"world"},
                ]})));
                let output = runtime
                    .run_single_query(super::single_query::OpenCodeSingleQueryRequest {
                        prompt: "query".to_owned(),
                        project_path: "/query".to_owned(),
                        model: "provider/model".to_owned(),
                        permission_mode: "default".to_owned(),
                        thinking_mode: mode,
                        timeout_ms: None,
                        signal: AbortSignal::new(),
                    })
                    .await
                    .unwrap();
                assert_eq!(output, "hello\nworld");
                let params = instance.client.prompt_parameters.take().unwrap();
                assert_eq!(params.get("variant").and_then(Value::as_str), variant);
                assert_eq!(params["tools"], json!({"*":false}));
                assert_eq!(
                    params["model"],
                    json!({"providerID":"provider","modelID":"model"})
                );
                assert_eq!(params["directory"], "/query");
                let mut expected = vec![OpenCodeRequest::SessionCreate];
                if mode != ThinkingMode::None {
                    expected.push(OpenCodeRequest::ProviderList);
                }
                expected.extend([
                    OpenCodeRequest::SessionPrompt,
                    OpenCodeRequest::SessionDelete,
                ]);
                for operation in expected {
                    assert_eq!(instance.requests.try_recv(), Ok(operation));
                }
            }
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn one_shot_timeout_keeps_native_session_cleanup_alive() {
    use std::{path::Path, time::Duration};

    use garcon_contract::{agent_integration::AgentSettingsEnvelope, chat_modes::ThinkingMode};
    use garcon_interface::{
        errors::{AgentIntegrationError, AgentIntegrationErrorCode},
        services::AgentSingleQueryRequest,
    };

    LocalSet::new()
        .run_until(async {
            let mut first = InstanceFixture::new(true);
            let runtime = runtime(&[&first]);
            let timed_out = spawn_local({
                let runtime = runtime.clone();
                async move {
                    runtime
                        .run_isolated_query(AgentSingleQueryRequest {
                            prompt: "hello".to_owned(),
                            model: String::new(),
                            thinking_mode: ThinkingMode::None,
                            timeout_ms: Some(garcon_js::Number(1000.0)),
                            settings: AgentSettingsEnvelope {
                                owner_id: "opencode".to_owned(),
                                schema_version: 1,
                                values: json!({}).into(),
                            },
                            endpoint: None,
                            signal: CancellationToken::new(),
                        })
                        .await
                }
            });
            assert_eq!(
                first.requests.recv().await,
                Some(OpenCodeRequest::SessionCreate)
            );
            assert_eq!(
                first.requests.recv().await,
                Some(OpenCodeRequest::SessionPrompt)
            );
            let parameters = first.client.prompt_parameters.take().unwrap();
            let directory = Path::new(parameters["directory"].as_str().unwrap());
            assert!(directory.is_dir());
            tokio::time::advance(Duration::from_secs(1)).await;
            let failure = timed_out
                .await
                .unwrap()
                .unwrap_err()
                .downcast::<AgentIntegrationError>()
                .unwrap();
            assert_eq!(failure.code, AgentIntegrationErrorCode::TIMEOUT);
            assert_eq!(failure.message, "Single query timed out after 1000ms.");
            assert!(!directory.exists());
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), first.requests.recv())
                    .await
                    .unwrap(),
                Some(OpenCodeRequest::SessionDelete),
            );
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn startup_closes_client_without_permission_reply() {
    LocalSet::new()
        .run_until(async {
            let first = InstanceFixture::new(false);
            let runtime = runtime(&[&first]);
            let failure = runtime.get_client().await.err().unwrap();
            assert_eq!(
                failure.to_string(),
                "OpenCode v2 client missing permission.reply; aborting startup"
            );
            assert_eq!(first.closed.get(), 1);
            assert!(runtime.get_client_if_initialized().is_none());
            assert!(runtime.is_temporarily_unavailable());
            runtime.shutdown().await;
        })
        .await;
}
