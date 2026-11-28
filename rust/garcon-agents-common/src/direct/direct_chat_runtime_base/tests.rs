use std::collections::VecDeque;
use std::time::Duration;

use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::producer::AgentRunFailureDetail;
use tokio::sync::{mpsc, oneshot};
use tokio::task::LocalSet;

use super::*;
use crate::direct::runtime_types::DirectEndpointRuntime;
use crate::direct::session_store::tests::Fixture;

enum Completion {
    Ready(&'static str),
    WaitForAbort,
    Deferred(oneshot::Receiver<&'static str>),
}

#[derive(Default)]
struct Observation {
    transcripts: RefCell<Vec<Vec<String>>>,
    completions: RefCell<VecDeque<Completion>>,
}

struct Protocol(Rc<Observation>);

#[async_trait(?Send)]
impl DirectChatProtocol for Protocol {
    type Message = String;

    fn build_user_message(&self, command: &str, _: &[AgentAttachment]) -> String {
        format!("user: {command}")
    }

    fn build_assistant_message(&self, content: &str) -> String {
        format!("assistant: {content}")
    }

    async fn stream_session(
        &self,
        session: DirectStreamSession<Self::Message>,
    ) -> ExecutorResult<DirectTurnCompletion> {
        self.0
            .transcripts
            .borrow_mut()
            .push(session.messages.to_vec());
        let completion = self
            .0
            .completions
            .borrow_mut()
            .pop_front()
            .expect("test turn has a completion");
        match completion {
            Completion::Ready(content) => Ok(DirectTurnCompletion {
                content: content.into(),
                checkpoint: None,
            }),
            Completion::WaitForAbort => {
                session.signal.cancelled().await;
                Err("cancelled request".into())
            }
            Completion::Deferred(content) => Ok(DirectTurnCompletion {
                content: content.await?.into(),
                checkpoint: None,
            }),
        }
    }
}

fn runtime(
    store: DirectSessionStore,
    completions: impl IntoIterator<Item = Completion>,
    limit: usize,
) -> (Rc<Observation>, Rc<DirectChatRuntimeBase<Protocol>>) {
    let observation = Rc::new(Observation {
        transcripts: RefCell::default(),
        completions: RefCell::new(completions.into_iter().collect()),
    });
    let runtime = DirectChatRuntimeBase::new(
        DirectChatRuntimeBaseConfig {
            runtime_label: "Synthetic direct".into(),
            default_model: "model".into(),
            sessions: store,
            max_messages_per_session: Some(limit),
        },
        Protocol(observation.clone()),
    )
    .unwrap();
    (observation, Rc::new(runtime))
}

fn request(
    run_id: &str,
    prompt: &str,
    sink: mpsc::UnboundedSender<AgentRuntimeEvent>,
) -> DirectExecutionRequest {
    let endpoint = DirectEndpointRuntime {
        selection: garcon_js::json::from_str(
            r#"{
            "apiProviderId":"provider","endpointId":"endpoint","providerLabel":"Synthetic",
            "protocol":"openai-compatible","baseUrl":"http://localhost/v1","model":"model",
            "isLocal":true,"capabilities":null,"headers":{},"credential":null
        }"#,
        )
        .unwrap(),
        credential: None,
    };
    DirectExecutionRequest {
        chat_id: "chat".into(),
        project_path: "/synthetic".into(),
        model: "model".into(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        execution_admission: None,
        command: prompt.into(),
        images: None,
        endpoint,
        operation: AgentRuntimeOperation {
            run_id: run_id.into(),
            publish: Rc::new(move |event| {
                assert!(sink.send(event).is_ok());
            }),
        },
    }
}

async fn next_events(
    receiver: &mut mpsc::UnboundedReceiver<AgentRuntimeEvent>,
) -> (usize, ProviderRunOutcome) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut rows = 0;
        loop {
            match receiver.recv().await.unwrap() {
                AgentRuntimeEvent::Rows { rows: batch } => rows += batch.len(),
                AgentRuntimeEvent::RunEnded { outcome, .. } => return (rows, outcome),
                _ => panic!("unexpected direct runtime event"),
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn persists_turns_but_only_projects_the_first_row_and_latest_window() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        let (observed, runtime) = runtime(fixture.store.clone(), [Completion::Ready("answer one"), Completion::Ready("answer two")], 2);
        let (sink, mut events) = mpsc::unbounded_channel();
        let activated = Rc::new(RefCell::new(None));
        let start = runtime.start_session(DirectStartRequest {
            execution: request("run-1", "first", sink.clone()),
            on_session_activated: Some(Rc::new({ let activated = activated.clone(); move |session| {
                activated.replace(Some(session.agent_session_id.clone()));
                Ok(())
            }})),
        }).await.unwrap();
        assert_eq!(activated.borrow().as_deref(), Some(start.agent_session_id.as_str()));
        let (count, outcome) = next_events(&mut events).await;
        assert_eq!(count, 1);
        assert!(matches!(outcome, ProviderRunOutcome::Finished { final_response: Some(AgentFinalResponse::Text { text }) } if text == "answer one"));
        let session_id = start.agent_session_id.clone();
        runtime.run_turn(DirectResumeRequest {
            execution: request("run-2", "second", sink), agent_session_id: start.agent_session_id,
            native_session: Some(start.native_session),
        }).await.unwrap();
        assert_eq!(next_events(&mut events).await.0, 1);
        assert_eq!(*observed.transcripts.borrow(), [vec!["user: first"], vec!["user: first", "user: second"]]);
        assert_eq!(fixture.store.load(&session_id).await.unwrap().records.len(), 4);
        assert!(!runtime.is_running(&session_id));
    }).await;
}

#[tokio::test]
async fn marks_an_aborted_run_finished_without_publishing_or_storing_an_answer() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            let (_, runtime) = runtime(fixture.store.clone(), [Completion::WaitForAbort], 4);
            let (sink, mut events) = mpsc::unbounded_channel();
            let start = runtime
                .start_session(DirectStartRequest {
                    execution: request("run-1", "first", sink),
                    on_session_activated: None,
                })
                .await
                .unwrap();
            assert!(runtime.is_running(&start.agent_session_id));
            assert_eq!(runtime.get_running_sessions().len(), 1);
            assert!(runtime.abort(&start.agent_session_id));
            assert!(!runtime.abort(&start.agent_session_id));
            assert!(matches!(
                next_events(&mut events).await,
                (
                    0,
                    ProviderRunOutcome::Finished {
                        final_response: None
                    }
                )
            ));
            assert_eq!(
                fixture
                    .store
                    .load(&start.agent_session_id)
                    .await
                    .unwrap()
                    .records
                    .len(),
                1
            );
        })
        .await;
}

#[tokio::test]
async fn refuses_abort_during_durable_answer_publication_and_rejects_empty_provider_output() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        let (_, runtime) = runtime(fixture.store.clone(), [Completion::Ready("answer"), Completion::Ready("  ")], 4);
        let (sink, mut events) = mpsc::unbounded_channel();
        let activated = Rc::new(RefCell::new(String::new()));
        let mut execution = request("run-1", "first", sink.clone());
        let publish = execution.operation.publish.clone();
        execution.operation.publish = Rc::new({
            let runtime = Rc::downgrade(&runtime);
            let activated = activated.clone();
            move |event| {
                if matches!(event, AgentRuntimeEvent::Rows { .. }) {
                    let runtime = runtime.upgrade().unwrap();
                    assert!(runtime.is_running(&activated.borrow()));
                    assert!(!runtime.abort(&activated.borrow()));
                }
                publish(event);
            }
        });
        let start = runtime.start_session(DirectStartRequest {
            execution,
            on_session_activated: Some(Rc::new(move |session| { activated.replace(session.agent_session_id.clone()); Ok(()) })),
        }).await.unwrap();
        assert_eq!(next_events(&mut events).await.0, 1);
        let id = start.agent_session_id.clone();
        runtime.run_turn(DirectResumeRequest { execution: request("run-2", "second", sink), agent_session_id: start.agent_session_id, native_session: Some(start.native_session) }).await.unwrap();
        assert!(matches!(next_events(&mut events).await, (0, ProviderRunOutcome::Failed { error: Some(AgentRunFailureDetail { code, message }) }) if code == "PROVIDER_FAILURE" && message.as_deref() == Some("Empty response from Synthetic direct")));
        assert_eq!(fixture.store.load(&id).await.unwrap().records.len(), 3);
    }).await;
}

#[tokio::test]
async fn a_successor_reloads_a_late_predecessor_record_without_retargeting_its_output() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        let (reply, deferred) = oneshot::channel();
        let (observed, runtime) = runtime(fixture.store.clone(), [Completion::Deferred(deferred), Completion::Ready("second answer"), Completion::Ready("third answer")], 8);
        let (first_sink, mut first_events) = mpsc::unbounded_channel();
        let (next_sink, mut next_events_rx) = mpsc::unbounded_channel();
        let started = runtime.start_session(DirectStartRequest {
            execution: request("run-1", "first", first_sink), on_session_activated: None,
        }).await.unwrap();
        assert!(runtime.abort(&started.agent_session_id));
        runtime.run_turn(DirectResumeRequest {
            execution: request("run-2", "second", next_sink.clone()), agent_session_id: started.agent_session_id.clone(),
            native_session: Some(started.native_session.clone()),
        }).await.unwrap();
        assert!(matches!(next_events(&mut next_events_rx).await, (1, ProviderRunOutcome::Finished { final_response: Some(AgentFinalResponse::Text { text }) }) if text == "second answer"));
        reply.send("late first answer").unwrap();
        assert!(matches!(next_events(&mut first_events).await, (1, ProviderRunOutcome::Finished { final_response: None })));
        runtime.run_turn(DirectResumeRequest {
            execution: request("run-3", "third", next_sink), agent_session_id: started.agent_session_id,
            native_session: Some(started.native_session),
        }).await.unwrap();
        assert_eq!(observed.transcripts.borrow()[2], ["user: first", "user: second", "assistant: second answer", "assistant: late first answer", "user: third"]);
    }).await;
}

#[tokio::test]
async fn does_not_publish_an_answer_when_the_durable_session_disappears() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        let (reply, deferred) = oneshot::channel();
        let (_, runtime) = runtime(fixture.store.clone(), [Completion::Deferred(deferred)], 4);
        let (sink, mut events) = mpsc::unbounded_channel();
        let started = runtime.start_session(DirectStartRequest {
            execution: request("run-1", "first", sink), on_session_activated: None,
        }).await.unwrap();
        fixture.store.delete(&started.agent_session_id).await.unwrap();
        reply.send("orphan answer").unwrap();
        assert!(matches!(next_events(&mut events).await, (0, ProviderRunOutcome::Failed { error: Some(AgentRunFailureDetail { code, .. }) }) if code == "TRANSCRIPT_UNAVAILABLE"));
    }).await;
}
