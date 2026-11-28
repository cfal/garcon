use super::*;

use garcon_agent_codex::{
    app_server::request_builders::ThreadForkSource, codex_forking::CodexForking,
    history_source::CodexHistoryService, service_tier::CodexSpeed, transcript::CodexNativeEvidence,
};
use garcon_agents_common::{
    forking::jsonl_forking::{JsonlNativeForkingOptions, create_jsonl_native_forking},
    native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
};
use garcon_contract::agent_integration::AgentSettingsEnvelope;
use garcon_interface::{
    native_fork::{AgentNativeFork, AgentNativeForkOutcome, AgentNativeForkRequest},
    producer::AgentEstablishedSession,
    transcript::AgentChatReference,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn paginated_point_forks_through_the_named_turn_or_refuses_an_unsettled_point() {
    LocalSet::new().run_until(async {
        for mode in ["fork", "fork-unsettled", "fork-downgrade"] {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let root = fixture._directory.path();
            let source_path = root.join("source.jsonl");
            let child_path = root.join("child.jsonl");
            let source_jsonl = b"{\"type\":\"session_meta\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"payload\":{\"id\":\"source-thread\",\"history_mode\":\"paginated\"}}\n";
            tokio::fs::write(&source_path, source_jsonl).await.unwrap();
            tokio::fs::write(&child_path, b"{}\n").await.unwrap();
            let make_client = {
                let fixture = fixture.clone();
                let child_path = child_path.to_str().unwrap().to_owned();
                Rc::new(move || {
                    let mut options = fixture.options(mode);
                    options.env.insert("SYNTHETIC_CODEX_NATIVE_PATH".into(), child_path.clone());
                    CodexAppServerClient::new(options)
                })
            };
            let runtime = CodexAppServerRuntime::new(CodexAppServerRuntimeOptions::new(
                Rc::new({ let make_client = make_client.clone(); move |_, _| make_client() }),
                Rc::new(|| "synthetic-occurrence".into()),
            ));
            let codec = Rc::new(PathNativeSessionCodec::new("codex"));
            let native_session = codec.encode(PathNativeSessionValue {
                path: source_path.to_str().map(str::to_owned), agent_session_id: Some("source-thread".into()), model_endpoint_id: None,
            });
            let evidence = Rc::new(CodexNativeEvidence {
                runtime: runtime.clone(),
                history: Rc::new(CodexHistoryService { create_client: make_client, logger: Rc::new(NoopLogger) }),
                native_sessions: codec.clone(),
                logger: Rc::new(NoopLogger),
            });
            let journal = create_jsonl_native_forking(JsonlNativeForkingOptions {
                native_evidence: evidence.clone(),
                native_sessions: codec.clone(),
                rewrite_entry: None, create_rewrite_entry: None,
                fork_whole_session: None, transform_entries: None,
                create_target_path: None, allow_unmaterialized_whole_session: true, semantic_digest: None,
            });
            let forking = CodexForking {
                native_sessions: codec.clone(), native_evidence: evidence,
                journal: Rc::new(journal),
                fork_paginated: Rc::new({
                    let runtime = runtime.clone();
                    let codec = codec.clone();
                    move |request, last_turn_id| {
                        let runtime = runtime.clone();
                        let codec = codec.clone();
                        async move {
                            let native = codec.decode(request.source.native_session.as_ref())?;
                            let result = runtime.fork_session(ThreadForkSource {
                                agent_session_id: request.source.agent_session_id.unwrap(), native_path: native.path,
                                model: Some(request.model), speed: (mode == "fork-downgrade").then_some(CodexSpeed::Fast),
                                project_path: request.source.project_path, codex_config: None, last_turn_id, model_provider: None,
                            }, None).await?;
                            Ok(result.map(|session| AgentEstablishedSession {
                                native_session: codec.encode(PathNativeSessionValue {
                                    path: session.native_path, agent_session_id: Some(session.agent_session_id.clone()), model_endpoint_id: None,
                                }),
                                agent_session_id: session.agent_session_id,
                                native_seed_receipt: None,
                            }))
                        }.boxed_local()
                    }
                }),
            };
            let settings = AgentSettingsEnvelope { owner_id: "codex".into(), schema_version: 1, values: Opaque::from_value(json!({})) };
            let request = AgentNativeForkRequest {
                chat_id: "fork-chat".into(), project_path: "/synthetic".into(), model: "synthetic-model".into(),
                permission_mode: PermissionMode::Default, thinking_mode: ThinkingMode::None, settings: settings.clone(),
                endpoint: None, signal: CancellationToken::new(),
                source: AgentChatReference {
                    chat_id: "source-chat".into(), agent_id: "codex".into(), agent_session_id: Some("source-thread".into()),
                    project_path: "/synthetic".into(), model: "synthetic-model".into(), native_session,
                    carry_over_revision: "synthetic".into(), native_seed_receipt: None, settings,
                },
                provider_meta: Some(Opaque::from_value(json!({"entryId":"turn:chosen-turn:item:answer"}))),
            };
            let outcome = forking.fork(request, None).await;
            if mode == "fork" {
                let AgentNativeForkOutcome::Materialized { session } = outcome.unwrap() else { panic!("expected materialized child") };
                assert_eq!(session.agent_session_id, "forked-thread");
                assert_eq!(codec.decode(session.native_session.as_ref()).unwrap().path.as_deref(), child_path.to_str());
            } else {
                let cause = outcome.unwrap_err();
                let error = cause.downcast_ref::<AgentIntegrationError>().unwrap();
                if mode == "fork-unsettled" {
                    assert_eq!(error.code, AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE);
                    assert_eq!(error.details.as_ref().unwrap()["nativeForkReason"], "not-settled");
                } else {
                    assert_eq!(error.code, AgentIntegrationErrorCode::INVALID_SETTINGS);
                }
            }
            let frames = fixture.frames();
            let fork = frames.iter().find(|frame| frame["method"] == "thread/fork").unwrap();
            assert_eq!(fork["params"]["threadId"], "source-thread");
            assert_eq!(fork["params"]["lastTurnId"], "chosen-turn");
            let archives: Vec<_> = frames.iter().filter(|frame| frame["method"] == "thread/archive").collect();
            if mode == "fork-downgrade" {
                assert_eq!(archives.len(), 1);
                assert_eq!(archives[0]["params"]["threadId"], "forked-thread");
            } else {
                assert!(archives.is_empty());
            }
            assert_eq!(tokio::fs::read(&source_path).await.unwrap(), source_jsonl);
            runtime.shutdown().await;
        }
    }).await;
}
