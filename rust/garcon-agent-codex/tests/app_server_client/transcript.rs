use super::*;

use garcon_agent_codex::{history_source::CodexHistoryService, transcript::CodexNativeEvidence};
use garcon_agents_common::native_session::{
    evidence_source::AgentNativeEvidenceSource,
    path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
};
use garcon_contract::agent_integration::AgentSettingsEnvelope;
use garcon_interface::{
    native_history::{AgentHistoryImportRequest, AgentNativeSessionAccess},
    transcript::AgentChatReference,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn native_evidence_keeps_pathless_identity_but_fails_closed_for_explicit_load() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let make_client =
                Rc::new(move || CodexAppServerClient::new(fixture.options("no-rollout")));
            let runtime = CodexAppServerRuntime::new(CodexAppServerRuntimeOptions::new(
                Rc::new({
                    let make_client = make_client.clone();
                    move |_, _| make_client()
                }),
                Rc::new(|| "synthetic-occurrence".into()),
            ));
            let codec = Rc::new(PathNativeSessionCodec::new("codex"));
            let native_session = codec.encode(PathNativeSessionValue {
                path: None,
                agent_session_id: Some("thread".into()),
                model_endpoint_id: Some("synthetic-endpoint".into()),
            });
            let evidence = CodexNativeEvidence {
                runtime: runtime.clone(),
                history: Rc::new(CodexHistoryService {
                    create_client: make_client,
                    logger: Rc::new(NoopLogger),
                }),
                native_sessions: codec,
                logger: Rc::new(NoopLogger),
            };
            let request = AgentHistoryImportRequest {
                chat: AgentChatReference {
                    chat_id: "chat".into(),
                    agent_id: "codex".into(),
                    agent_session_id: Some("thread".into()),
                    project_path: "/synthetic".into(),
                    model: "synthetic-model".into(),
                    native_session: native_session.clone(),
                    carry_over_revision: "synthetic".into(),
                    native_seed_receipt: None,
                    settings: AgentSettingsEnvelope {
                        owner_id: "codex".into(),
                        schema_version: 1,
                        values: Opaque::from_value(json!({})),
                    },
                },
                signal: CancellationToken::new(),
            };
            assert_eq!(
                evidence
                    .resolve_native_session(request.clone())
                    .await
                    .unwrap(),
                native_session
            );
            assert_eq!(
                evidence.describe_source(request.clone()).await.unwrap(),
                None
            );
            let error = evidence.load(request.clone()).await.unwrap_err();
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            assert_eq!(
                error.code,
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
            );
            assert_eq!(error.details.as_ref().unwrap()["reason"], "not-found");
            assert!(
                evidence
                    .load_legacy(request)
                    .await
                    .unwrap()
                    .messages
                    .is_empty()
            );
            runtime.shutdown().await;
        })
        .await;
}
