use std::{cell::Cell, path::Path};

use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    chat_modes::{PermissionMode, ThinkingMode},
    chat_types::UserMessage,
    transcript_seed::{NativeSeedPlacement, NativeSeedReceiptInput, create_native_seed_receipt},
};
use garcon_interface::{
    native_history::{AgentNativeSessionAccess, AgentNativeSessionReleaseRequest},
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    },
    transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation},
};

use super::super::fork_jsonl::{ForkEntryRewrite, ForkTranscriptTransformResult};
use super::*;
use crate::native_session::evidence_source::AgentNativeEvidenceSnapshot;

const SOURCE: &str = concat!(
    "{\"type\":\"session\",\"sessionId\":\"source-id\"}\n",
    "{\"type\":\"message\",\"content\":\"first\"}\n",
    "{\"type\":\"message\",\"content\":\"second\"}\n",
);

struct Evidence {
    codec: Rc<PathNativeSessionCodec>,
    source: String,
    fail_verification: Cell<bool>,
    cancel_verification: Cell<bool>,
    load_failure: Cell<Option<&'static str>>,
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for Evidence {
    async fn resolve_native_session(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        Ok(self.codec.encode(PathNativeSessionValue {
            path: Some(self.source.clone()),
            agent_session_id: request.chat.agent_session_id,
            model_endpoint_id: None,
        }))
    }

    async fn describe_source(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        Ok(self
            .codec
            .decode(request.chat.native_session.as_ref())?
            .path
            .map(|value| AgentTranscriptSourceLocation::FilesystemPath { value }))
    }

    async fn release(&self, _: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentNativeEvidenceSource for Evidence {
    async fn load(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        let path = self
            .codec
            .decode(request.chat.native_session.as_ref())?
            .path
            .ok_or("no path")?;
        if path != self.source && self.fail_verification.get() {
            return Err("synthetic verification failure".into());
        }
        if path != self.source && self.cancel_verification.get() {
            request.signal.cancel();
        }
        check_signal(Some(&request.signal))?;
        if let Some(reason) = self.load_failure.get() {
            return Err(AgentIntegrationError::new(
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
                "Native history unavailable",
                false,
                json!({ "reason": reason }).as_object().cloned(),
            )
            .into());
        }
        let content = fs::read_to_string(path).await?;
        let mut messages = Vec::new();
        let mut offset = 0;
        for (index, line) in content.lines().enumerate() {
            let entry = garcon_js::json::parse(line)?;
            if entry["type"] == "message"
                && let Some(content) = entry["content"].as_str()
            {
                let mut row = NativeSourced::new(ChatMessage::User(UserMessage {
                    timestamp: "2026-07-20T00:00:00.000Z".into(),
                    content: content.into(),
                    images: None,
                    metadata: None,
                    presentation: None,
                }));
                attach_native_message_source(
                    &mut row,
                    Some(NativeMessageSourceInput {
                        line_number: Some((index + 1) as f64),
                        byte_offset: Some(offset as f64),
                        within_source_ordinal: Some(0.0),
                        ..Default::default()
                    }),
                );
                messages.push(row);
            }
            offset += line.len() + 1;
        }
        Ok(AgentNativeEvidenceSnapshot { messages })
    }
}

async fn fixture(
    root: &Path,
) -> (
    Rc<Evidence>,
    JsonlNativeForkingOptions,
    AgentNativeForkRequest,
) {
    let source = root.join("source.jsonl");
    fs::write(&source, SOURCE).await.unwrap();
    let codec = Rc::new(PathNativeSessionCodec::new("test"));
    let evidence = Rc::new(Evidence {
        codec: codec.clone(),
        source: source.to_string_lossy().into_owned(),
        fail_verification: Cell::new(false),
        cancel_verification: Cell::new(false),
        load_failure: Cell::new(None),
    });
    let target = root
        .join("fixed-target.jsonl")
        .to_string_lossy()
        .into_owned();
    let options = JsonlNativeForkingOptions {
        native_evidence: evidence.clone(),
        native_sessions: codec.clone(),
        rewrite_entry: Some(Rc::new(|entry, context| {
            if entry["type"] == "session" {
                let mut entry = entry.as_value().clone();
                entry["sessionId"] = json!(context.target_agent_session_id);
                return Ok(ForkEntryRewrite::Replace(entry.into()));
            }
            Ok(ForkEntryRewrite::Unchanged)
        })),
        create_rewrite_entry: None,
        fork_whole_session: None,
        transform_entries: None,
        create_target_path: Some(Rc::new(move |_| Ok(target.clone()))),
        allow_unmaterialized_whole_session: false,
        semantic_digest: None,
    };
    let settings = AgentSettingsEnvelope {
        owner_id: "test".into(),
        schema_version: 1,
        values: json!({}).into(),
    };
    let project_path = root.to_string_lossy().into_owned();
    let request = AgentNativeForkRequest {
        chat_id: "target".into(),
        project_path: project_path.clone(),
        model: "synthetic-model".into(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        settings: settings.clone(),
        endpoint: None,
        signal: CancellationToken::new(),
        source: AgentChatReference {
            chat_id: "source".into(),
            agent_id: "test".into(),
            agent_session_id: Some("source-id".into()),
            project_path,
            model: "synthetic-model".into(),
            native_session: codec.encode(PathNativeSessionValue {
                path: Some(root.join("stale.jsonl").to_string_lossy().into_owned()),
                agent_session_id: Some("source-id".into()),
                model_endpoint_id: None,
            }),
            carry_over_revision: "revision".into(),
            native_seed_receipt: None,
            settings,
        },
        provider_meta: Some(json!({"lineNumber":2,"withinSourceOrdinal":0}).into()),
    };
    (evidence, options, request)
}

#[tokio::test]
async fn a_selected_native_row_copies_the_resolved_prefix_and_returns_the_target_path() {
    let root = tempfile::tempdir().unwrap();
    let (_, options, request) = fixture(root.path()).await;
    let codec = options.native_sessions.clone();
    let fork = create_jsonl_native_forking(options);
    let AgentNativeForkOutcome::Materialized { session } = fork.fork(request, None).await.unwrap()
    else {
        panic!("expected materialized fork");
    };
    let target = root.path().join("fixed-target.jsonl");
    let native = codec.decode(session.native_session.as_ref()).unwrap();
    assert_eq!(Path::new(native.path.as_deref().unwrap()), target);
    assert_eq!(
        fs::read_to_string(&target).await.unwrap(),
        format!(
            "{{\"type\":\"session\",\"sessionId\":\"{}\"}}\n{{\"type\":\"message\",\"content\":\"first\"}}\n",
            session.agent_session_id
        ),
    );
    fork.discard(session, CancellationToken::new(), None)
        .await
        .unwrap();
    assert!(!target.exists());
}

#[tokio::test]
async fn resolves_the_source_before_the_native_whole_session_callback() {
    let root = tempfile::tempdir().unwrap();
    let (evidence, mut options, mut request) = fixture(root.path()).await;
    request.provider_meta = None;
    request.source.native_session = None;
    options.fork_whole_session = Some(Rc::new(move |request| {
        let evidence = evidence.clone();
        Box::pin(async move {
            assert_eq!(
                evidence
                    .codec
                    .decode(request.source.native_session.as_ref())?
                    .path
                    .as_deref(),
                Some(evidence.source.as_str())
            );
            Ok(Some(AgentEstablishedSession {
                agent_session_id: "forked-session".into(),
                native_session: None,
                native_seed_receipt: None,
            }))
        })
    }));
    let AgentNativeForkOutcome::Materialized { session } = create_jsonl_native_forking(options)
        .fork(request, None)
        .await
        .unwrap()
    else {
        panic!("expected materialized fork");
    };
    assert_eq!(session.agent_session_id, "forked-session");
    assert!(!root.path().join("fixed-target.jsonl").exists());
}

fn seed_receipt() -> garcon_contract::transcript_seed::NativeSeedReceipt {
    create_native_seed_receipt(NativeSeedReceiptInput {
        agent_session_id: "source-id",
        placement: NativeSeedPlacement::UserPrefix,
        prefix: "first",
        format: None,
    })
    .unwrap()
}

#[tokio::test]
async fn retargets_a_receipt_only_when_the_fork_preserves_its_recorded_prefix() {
    for preserve in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let (_, mut options, mut request) = fixture(root.path()).await;
        let receipt = seed_receipt();
        request.source.native_seed_receipt = Some(receipt.clone());
        if !preserve {
            request.provider_meta = None;
            options.rewrite_entry = Some(Rc::new(|entry, _| {
                if entry["content"] == "first" {
                    let mut entry = entry.as_value().clone();
                    entry["content"] = json!("rewritten");
                    Ok(ForkEntryRewrite::Replace(entry.into()))
                } else {
                    Ok(ForkEntryRewrite::Unchanged)
                }
            }));
        }
        let AgentNativeForkOutcome::Materialized { session } = create_jsonl_native_forking(options)
            .fork(request, None)
            .await
            .unwrap()
        else {
            panic!("expected materialized fork");
        };
        assert_eq!(
            session.native_seed_receipt,
            preserve.then_some(garcon_contract::transcript_seed::NativeSeedReceipt {
                agent_session_id: session.agent_session_id,
                ..receipt
            })
        );
    }
}

#[tokio::test]
async fn removes_an_untransformed_whole_session_fork_cancelled_during_receipt_verification() {
    let root = tempfile::tempdir().unwrap();
    let (evidence, mut options, mut request) = fixture(root.path()).await;
    evidence.cancel_verification.set(true);
    options.rewrite_entry = None;
    request.provider_meta = None;
    request.source.native_seed_receipt = Some(seed_receipt());
    let signal = request.signal.clone();
    let error = create_jsonl_native_forking(options)
        .fork(request, None)
        .await
        .unwrap_err();
    assert!(signal.is_cancelled());
    let abort = check_signal(Some(&signal)).unwrap_err();
    assert_eq!(error.to_string(), abort.to_string());
    assert!(!root.path().join("fixed-target.jsonl").exists());
}

#[tokio::test]
async fn preserves_source_missing_and_invalid_metadata_distinctions_during_point_lookup() {
    for reason in [None, Some("source-missing"), Some("invalid-metadata")] {
        let root = tempfile::tempdir().unwrap();
        let (evidence, options, request) = fixture(root.path()).await;
        if reason.is_none() {
            fs::remove_file(&evidence.source).await.unwrap();
        }
        evidence.load_failure.set(reason);
        let error = create_jsonl_native_forking(options)
            .fork(request, None)
            .await
            .unwrap_err();
        let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(
            error.code,
            AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
        );
        if reason == Some("invalid-metadata") {
            assert!(!error.retryable);
            assert_eq!(error.to_string(), "Native history unavailable");
            assert_eq!(
                error.details.as_ref().unwrap()["reason"],
                "invalid-metadata"
            );
        } else {
            assert!(error.retryable);
            assert_eq!(
                error.to_string(),
                "The source native transcript is unavailable"
            );
            assert_eq!(
                error.details.as_ref().unwrap()["nativeForkReason"],
                "source-missing"
            );
        }
        assert!(!root.path().join("fixed-target.jsonl").exists());
    }
}

#[tokio::test]
async fn rejects_a_retained_prefix_mutation_observed_while_copying() {
    let root = tempfile::tempdir().unwrap();
    let (evidence, mut options, request) = fixture(root.path()).await;
    options.transform_entries = Some(Rc::new(move |input| {
        let evidence = evidence.clone();
        Box::pin(async move {
            fs::write(&evidence.source, SOURCE.replace("first", "changed")).await?;
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: None,
            })
        })
    }));
    let error = create_jsonl_native_forking(options)
        .fork(request, None)
        .await
        .unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(
        error.code,
        AgentIntegrationErrorCode::SOURCE_REVISION_CHANGED
    );
    assert_eq!(
        error.message,
        "Source transcript changed while the fork was being created"
    );
    assert!(error.retryable);
    assert!(!root.path().join("fixed-target.jsonl").exists());
}

#[tokio::test]
async fn verifies_the_semantic_digest_of_the_materialized_prefix() {
    for expected in ["first", "second"] {
        let root = tempfile::tempdir().unwrap();
        let (_, mut options, request) = fixture(root.path()).await;
        options.transform_entries = Some(Rc::new(move |input| {
            Box::pin(async move {
                Ok(ForkTranscriptTransformResult {
                    entries: input.selected_entries,
                    expected_semantic_digest: Some(expected.to_owned()),
                })
            })
        }));
        options.semantic_digest = Some(Rc::new(|rows| {
            Box::pin(async move {
                let [ChatMessage::User(user)] = rows else {
                    panic!("expected exactly the selected user row");
                };
                Ok(user.content.clone())
            })
        }));
        let result = create_jsonl_native_forking(options)
            .fork(request, None)
            .await;
        let target = root.path().join("fixed-target.jsonl");
        if expected == "first" {
            assert!(matches!(
                result.unwrap(),
                AgentNativeForkOutcome::Materialized { .. }
            ));
            assert!(target.exists());
        } else {
            let error = result.unwrap_err();
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            assert_eq!(
                error.code,
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
            );
            assert_eq!(
                error.message,
                "The provider-native fork did not preserve its selected prefix"
            );
            assert!(!error.retryable);
            assert!(!target.exists());
        }
    }
}

#[tokio::test]
async fn missing_provider_points_fail_before_any_target_and_failed_verification_removes_it() {
    let root = tempfile::tempdir().unwrap();
    let (evidence, mut options, mut request) = fixture(root.path()).await;
    let target = root.path().join("fixed-target.jsonl");
    options.transform_entries = Some(Rc::new(|input| {
        Box::pin(async move {
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: Some("synthetic-digest".into()),
            })
        })
    }));
    let fork = create_jsonl_native_forking(options);
    let selected = request
        .provider_meta
        .replace(json!({"lineNumber":99}).into());
    let error = fork.fork(request.clone(), None).await.unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(
        error.code,
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
    );
    assert!(error.retryable);
    assert!(!target.exists());

    request.provider_meta = selected;
    evidence.fail_verification.set(true);
    let error = fork.fork(request, None).await.unwrap_err();
    assert_eq!(error.to_string(), "synthetic verification failure");
    assert!(!target.exists());
}
