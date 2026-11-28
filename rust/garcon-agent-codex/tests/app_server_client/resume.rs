use super::*;

use garcon_agent_codex::runtime_types::CodexResumeRequest;
use garcon_contract::chat_types::CompactionTrigger;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

fn request(
    path: &std::path::Path,
    run_id: &str,
) -> (CodexExecutionRequest, UnboundedReceiver<AgentRuntimeEvent>) {
    let (publish, events) = unbounded_channel();
    let operation = codex_operation(
        "chat",
        run_id,
        Rc::new(move |event| {
            let _ = publish.send(event);
        }),
    );
    (
        CodexExecutionRequest {
            activation: ThreadActivationSettings {
                model: "synthetic-model".into(),
                project_path: path.to_str().unwrap().into(),
                permission_mode: PermissionMode::Default,
                speed: None,
                codex_config: None,
            },
            thinking_mode: None,
            model_endpoint_id: None,
            client_message_id: Some(format!("input-{run_id}")),
            admission: None,
            command: "Synthetic prompt.".into(),
            images: vec![],
            env_overrides: None,
            operation,
        },
        events,
    )
}

async fn completed(
    events: &mut UnboundedReceiver<AgentRuntimeEvent>,
    run_id: &str,
) -> Vec<ChatMessage> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut messages = Vec::new();
        let mut steerable = 0;
        loop {
            match events.recv().await.unwrap() {
                AgentRuntimeEvent::Steerable => steerable += 1,
                AgentRuntimeEvent::Rows { rows } => {
                    messages.extend(rows.into_iter().map(|row| row.message))
                }
                AgentRuntimeEvent::RunEnded {
                    run_id: actual,
                    outcome,
                    ..
                } => {
                    assert_eq!(actual, run_id);
                    assert!(matches!(outcome, ProviderRunOutcome::Finished { .. }));
                    assert_eq!(steerable, 1);
                    return messages;
                }
                _ => panic!("unexpected runtime event"),
            }
        }
    })
    .await
    .expect("terminal deadline")
}

#[tokio::test]
async fn resume_reconciles_a_missing_path_and_reuses_the_writer_for_compaction() {
    LocalSet::new().run_until(async {
        let fixture = Rc::new(Fixture::new(FIXTURE));
        let root = fixture._directory.path();
        let actual_path = root.join("moved.jsonl").to_str().unwrap().to_owned();
        let old_path = root.join("absent.jsonl").to_str().unwrap().to_owned();
        tokio::fs::write(&actual_path, r#"{"type":"session_meta","timestamp":"2026-02-21T10:00:00.000Z","payload":{"id":"thread"}}"# .to_owned() + "\n")
            .await
            .unwrap();
        let factory = {
            let fixture = fixture.clone();
            let native_path = actual_path.clone();
            Rc::new(move |_, _: Option<&garcon_agent_codex::runtime_types::CodexProviderConfig>| {
                let mut options = fixture.options("managed-resume");
                options.env.insert("SYNTHETIC_CODEX_NATIVE_PATH".into(), native_path.clone());
                CodexAppServerClient::new(options)
            })
        };
        let clock = Rc::new(ManualClock::new(0));
        let mut options = CodexAppServerRuntimeOptions::new(factory, Rc::new(|| "synthetic-occurrence".into()));
        options.clock = clock.clone();
        options.retained_source_idle_ms = 10;
        options.retained_source_purge_interval_ms = 5;
        let runtime = CodexAppServerRuntime::new(options);

        let (execution, mut events) = request(root, "resume");
        runtime.run_turn(CodexResumeRequest {
            execution, agent_session_id: "thread".into(), native_path: Some(old_path),
        }).await.unwrap();
        assert!(matches!(completed(&mut events, "resume").await.as_slice(), [ChatMessage::Assistant(_)]));
        let (execution, mut events) = request(root, "compaction");
        runtime.compact(CodexResumeRequest {
            execution, agent_session_id: "thread".into(), native_path: Some(actual_path.clone()),
        }).await.unwrap();
        let messages = completed(&mut events, "compaction").await;
        assert!(matches!(messages.as_slice(), [ChatMessage::Compaction(message)] if message.trigger == CompactionTrigger::Manual), "compaction must carry the manual trigger");
        assert_eq!(runtime.source_endpoint_id("thread"), Some(None));
        clock.set(10);
        runtime.start_purge_timer();
        tokio::time::timeout(Duration::from_secs(3), async {
            while runtime.source_endpoint_id("thread").is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("retained writer is reclaimed after the idle deadline");
        runtime.shutdown().await;

        let frames = fixture.frames();
        let requests: Vec<_> = frames.iter().filter_map(|frame| frame["method"].as_str()).collect();
        assert_eq!(requests.iter().filter(|&&method| method == "initialize").count(), 2);
        assert_eq!(requests.iter().filter(|&&method| method == "thread/resume").count(), 1);
        let resume = frames.iter().find(|frame| frame["method"] == "thread/resume").unwrap();
        assert_eq!(resume["params"]["path"], actual_path);
        assert_eq!(resume["params"]["excludeTurns"], true);
    }).await;
}

#[tokio::test]
async fn concurrent_resume_and_compaction_do_not_replace_an_active_writer() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let root = fixture._directory.path();
            let path = root.join("rollout.jsonl").to_str().unwrap().to_owned();
            tokio::fs::write(&path, "{}\n").await.unwrap();
            let factory = {
                let fixture = fixture.clone();
                Rc::new(
                    move |_, _: Option<&garcon_agent_codex::runtime_types::CodexProviderConfig>| {
                        let mut options = fixture.options("held-turn");
                        options
                            .env
                            .insert("SYNTHETIC_CODEX_NATIVE_PATH".into(), path.clone());
                        CodexAppServerClient::new(options)
                    },
                )
            };
            let runtime = CodexAppServerRuntime::new(CodexAppServerRuntimeOptions::new(
                factory,
                Rc::new(|| "synthetic-occurrence".into()),
            ));
            let (execution, mut events) = request(root, "initial");
            runtime
                .start_session(CodexStartRequest {
                    execution,
                    on_session_activated: None,
                })
                .await
                .unwrap();
            assert!(matches!(
                events.try_recv().unwrap(),
                AgentRuntimeEvent::Steerable
            ));
            let resume = |run_id| CodexResumeRequest {
                execution: request(root, run_id).0,
                agent_session_id: "thread".into(),
                native_path: None,
            };
            let (turn, compaction) = tokio::join!(
                runtime.run_turn(resume("other")),
                runtime.compact(resume("compact"))
            );
            let error = turn.unwrap_err();
            assert_eq!(
                error.downcast_ref::<AgentIntegrationError>().unwrap().code,
                AgentIntegrationErrorCode::SESSION_BUSY
            );
            assert_eq!(
                compaction.unwrap_err().to_string(),
                "Cannot compact while a Codex turn is active"
            );
            assert!(runtime.is_running("thread"));
            runtime.shutdown().await;
            let frames = fixture.frames();
            assert_eq!(
                frames
                    .iter()
                    .filter(|frame| frame["method"] == "initialize")
                    .count(),
                1
            );
            assert!(
                !frames.iter().any(|frame| frame["method"] == "thread/resume"
                    || frame["method"] == "thread/compact/start")
            );
        })
        .await;
}
