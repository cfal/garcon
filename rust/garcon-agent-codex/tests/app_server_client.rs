#![cfg(unix)]

use std::{
    cell::{Cell, RefCell},
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    rc::Rc,
    time::Duration,
};

use futures::FutureExt;
use garcon_agent_codex::app_server::{
    cli::{CodexCommandSource, IncompatibleCodex, ResolvedCodexCli},
    client::{
        CodexAppServerClient, CodexAppServerClientOptions, CodexAppServerDeliveryError,
        CodexAppServerEvent, CodexAppServerMetric, CodexAppServerRpcError, CodexDeliveryOutcome,
        CodexSteerRequestOptions,
    },
    native_path_discovery_refresh::NativePathDiscoveryRefreshLimiter,
    operation_routes::codex_operation,
    protocol::JsonRpcId,
    request_builders::{
        CodexThreadConfiguration, CodexThreadSettings, CodexThreadSettingsSandboxPolicy,
        ThreadActivationSettings, thread_settings_target_from_snapshot,
    },
    runtime::{
        client_events::{BufferedClientEvent, CodexClientEvents},
        interrupt::CodexInterrupt,
        managed::{CodexAppServerRuntime, CodexAppServerRuntimeOptions},
        permission_events::{CodexApprovalEvents, CodexApprovalRoute},
        source_registry::{CodexSessionSource, CodexSourceActivation, CodexSourceRegistry},
        thread_settings::CodexSourceThreadSettings,
        turn_events::dispatch_turn_notification,
        utility::CodexAppServerUtility,
    },
    runtime_support::NoopLogger,
    steering::classify_codex_steer_rejection,
};
use garcon_agent_codex::runtime_types::{CodexExecutionRequest, CodexStartRequest};
use garcon_agent_codex::service_tier::CodexServiceTier;
use garcon_agent_codex::slash_command_discovery::CodexSkillDiscovery;
use garcon_agents_common::execution::runtime_events::{
    AgentRuntimeEvent, ProviderRunOutcome, RuntimeSteerRequest,
};
use garcon_contract::chat_types::ChatMessage;
use garcon_contract::{
    async_user_questions::{AsyncQuestionReply, async_question_reply_text},
    chat_command_contracts::PermissionDecisionPayload,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::host::AgentLogger;
use garcon_interface::producer::{
    AgentFinalResponse, AgentProviderPermissionLifecycle, AgentTerminalPermission,
};
use garcon_interface::services::{AgentSteerRejectionReason, AgentSteerResult};
use garcon_js::clock::ManualClock;
use garcon_js::json::{Opaque, from_str};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::json;
use tempfile::{TempDir, tempdir};
use tokio::{sync::oneshot, task::LocalSet};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/oracles/app-server-fixture.ts"
);
const INTEGRATION_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../integration-tests/support/fake-codex-app-server.ts"
);

struct Fixture {
    _directory: TempDir,
    command: PathBuf,
    trace: PathBuf,
}

#[tokio::test]
async fn native_approval_expires_only_for_the_owning_thread_and_reused_ids_are_fenced() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options("approval-events"));
            let next_id = Cell::new(0);
            let approvals = Rc::new(CodexApprovalEvents::new(
                Rc::new(NoopLogger),
                Rc::new(ManualClock::new(0)),
                Rc::new(move || {
                    next_id.set(next_id.get() + 1);
                    format!("occurrence-{}", next_id.get())
                }),
            ));
            let publications = Rc::new(RefCell::new(Vec::new()));
            let operation = codex_operation("chat", "run", Rc::new({
                let publications = publications.clone();
                move |event| publications.borrow_mut().push(event)
            }));
            let events = CodexClientEvents::buffer(
                &client,
                Rc::new(NoopLogger),
                move |client, event| match event {
                    BufferedClientEvent::ServerRequest(request) => approvals.request(
                        client,
                        &request,
                        |thread, turn| (thread == "thread" && turn == "turn").then(|| CodexApprovalRoute {
                            operation: operation.clone(),
                            permission_mode: PermissionMode::Default,
                            active: true,
                        }),
                    ),
                    BufferedClientEvent::Notification(note) if note.method == "serverRequest/resolved" => {
                        approvals.resolved(client, note.params.as_deref().unwrap())
                    }
                    _ => Ok(()),
                },
                |_, _| Ok(()),
            );
            events.release().unwrap();
            let send = |method: &'static str, params| {
                let client = client.clone();
                async move {
                    client.request(method, Some(&params), Some(Duration::from_secs(3))).await.unwrap();
                }
            };
            send("send-approval", json!({"requestId":101,"threadId":"thread","turnId":"wrong"})).await;
            send("send-approval", json!({"requestId":102,"threadId":"thread","turnId":"turn"})).await;
            let decision = |index| {
                let publications = publications.borrow();
                match publications.get(index) {
                    Some(AgentRuntimeEvent::Permission { decision: Some(decision), run_id, .. }) => {
                        assert_eq!(run_id, "run");
                        decision.clone()
                    }
                    _ => panic!("expected captured approval capability"),
                }
            };
            let original = decision(0);
            send("resolve-approval", json!({"requestId":102,"threadId":"other"})).await;
            assert_eq!(publications.borrow().len(), 1);
            send("resolve-approval", json!({"requestId":102,"threadId":"thread"})).await;
            assert!(matches!(
                &publications.borrow()[1],
                AgentRuntimeEvent::Permission {
                    lifecycle: AgentProviderPermissionLifecycle::Terminal(AgentTerminalPermission::Expired {
                        permission_occurrence_id,
                    }),
                    decision: None,
                    ..
                } if permission_occurrence_id == original.permission_occurrence_id()
            ));
            send("send-approval", json!({"requestId":102,"threadId":"thread","turnId":"turn"})).await;
            let replacement = decision(2);
            assert_ne!(original.permission_occurrence_id(), replacement.permission_occurrence_id());
            let allow = PermissionDecisionPayload { allow: true, always_allow: Some(false), response: None };
            assert_eq!(original.respond(allow.clone()).await.unwrap_err().to_string(), "Codex permission occurrence is no longer pending");
            replacement.respond(allow.clone()).await.unwrap();
            assert!(replacement.respond(allow).await.is_err());
            send("resolve-approval", json!({"requestId":102,"threadId":"thread"})).await;
            assert_eq!(publications.borrow().len(), 3);
            let frames: Vec<_> = fixture.frames().into_iter().filter(|frame| {
                frame.get("method").is_none() && matches!(frame["id"].as_i64(), Some(101 | 102))
            }).collect();
            assert_eq!(frames, [
                json!({"id":101,"result":{"decision":"decline"}}),
                json!({"id":102,"result":{"decision":"accept"}}),
            ]);
            client.shutdown().await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn native_turn_events_publish_rows_before_completion_and_keep_their_captured_operation() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options("turn-events"));
            let registry = Rc::new(RefCell::new(CodexSourceRegistry::default()));
            let observed = Rc::new(RefCell::new(Vec::new()));
            let events = CodexClientEvents::buffer(
                &client,
                Rc::new(NoopLogger),
                {
                    let registry = registry.clone();
                    let observed = observed.clone();
                    move |client, event| {
                        if let BufferedClientEvent::Notification(note) = event
                            && let Some(completion) = dispatch_turn_notification(
                                &registry,
                                &NoopLogger,
                                client,
                                "2026-02-21T10:00:00.000Z",
                                &note,
                            )
                        {
                            assert_eq!(
                                completion.final_response,
                                Some(AgentFinalResponse::Text {
                                    text: "Final\n".into()
                                }),
                            );
                            observed.borrow_mut().push((
                                completion.operation.run_id.clone(),
                                if completion.is_active {
                                    "current end"
                                } else {
                                    "detached end"
                                }
                                .into(),
                            ));
                        }
                        Ok(())
                    }
                },
                |_, _| Ok(()),
            );
            let operation = |run_id: &'static str| {
                let observed = observed.clone();
                codex_operation(
                    "chat",
                    run_id,
                    Rc::new(move |event| {
                        let mut observed = observed.borrow_mut();
                        match event {
                            AgentRuntimeEvent::Steerable => {
                                observed.push((run_id.into(), "steerable".into()))
                            }
                            AgentRuntimeEvent::Rows { rows } => {
                                for row in rows {
                                    let ChatMessage::Assistant(message) = row.message else {
                                        panic!("expected assistant row");
                                    };
                                    observed.push((run_id.into(), message.content));
                                }
                            }
                            _ => panic!("unexpected turn event"),
                        }
                    }),
                )
            };
            let old = operation("old-run");
            let source = Rc::new(CodexSessionSource::new(
                "thread".into(),
                client.clone(),
                old.clone(),
                CodexSourceActivation {
                    native_path: None,
                    codex_home: None,
                    model_endpoint_id: None,
                    runtime_identity: "synthetic".into(),
                    started_at: "2026-02-21T10:00:00.000Z".into(),
                    confirmed_settings: thread_settings_target_from_snapshot(
                        &CodexThreadSettings {
                            model: "model".into(),
                            service_tier: None,
                            effort: None,
                            approval_policy: json!("never"),
                            approvals_reviewer: "user".into(),
                            sandbox_policy: CodexThreadSettingsSandboxPolicy {
                                kind: "readOnly".into(),
                                fields: serde_json::Map::new(),
                            },
                        },
                        PermissionMode::Default,
                    ),
                    provider_owns_effort: true,
                    settings_timeout: Duration::from_secs(1),
                    admitted_tier: CodexServiceTier::Default,
                },
            ));
            registry.borrow_mut().activate(source.clone());
            garcon_agent_codex::app_server::runtime_session_state::CodexTurnRoutes::adopt_turn(
                &source.routes,
                "old-turn",
                old,
            );
            let next = operation("next-run");
            source.routes.borrow_mut().reactivate(next);
            let send = |turn_id, start| {
                let client = client.clone();
                async move {
                    client
                        .request(
                            "send-turn-events",
                            Some(&json!({"threadId":"thread","turnId":turn_id,"start":start})),
                            Some(Duration::from_secs(3)),
                        )
                        .await
                        .unwrap();
                }
            };
            send("next-turn", true).await;
            assert_eq!(observed.borrow().len(), 1, "early events are buffered");
            events.release().unwrap();
            send("old-turn", false).await;
            let observed = observed.borrow().clone();
            assert_eq!(
                observed
                    .iter()
                    .map(|(run, event)| (run.as_str(), event.as_str()))
                    .collect::<Vec<_>>(),
                [
                    ("old-run", "steerable"),
                    ("next-run", "steerable"),
                    ("next-run", "Live"),
                    ("next-run", "Final\n"),
                    ("next-run", "current end"),
                    ("old-run", "Live"),
                    ("old-run", "Final\n"),
                    ("old-run", "detached end"),
                ],
            );
            client.shutdown().await.unwrap();
        })
        .await;
}

impl Fixture {
    fn new(fixture: &str) -> Self {
        let directory = tempdir().unwrap();
        let command = directory.path().join("fake-codex");
        let trace = directory.path().join("wire.jsonl");
        fs::write(
            &command,
            format!(
                "#!/bin/sh\nexec bun '{}' \"$@\"\n",
                fixture.replace('\'', "'\\''")
            ),
        )
        .unwrap();
        fs::set_permissions(&command, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _directory: directory,
            command,
            trace,
        }
    }

    fn options(&self, mode: &str) -> CodexAppServerClientOptions {
        let command = self.command.to_str().unwrap().to_owned();
        let mut options = CodexAppServerClientOptions::new(Rc::new(move |_| {
            let command = command.clone();
            async move {
                Ok(ResolvedCodexCli {
                    command,
                    source: CodexCommandSource::Path,
                })
            }
            .boxed_local()
        }));
        options.env.insert(
            "SYNTHETIC_CODEX_TRACE".into(),
            self.trace.to_str().unwrap().into(),
        );
        options
            .env
            .insert("SYNTHETIC_CODEX_MODE".into(), mode.into());
        options
    }

    fn frames(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(&self.trace)
            .unwrap()
            .lines()
            .map(|line| from_str(line).unwrap())
            .collect()
    }
}

fn steer_params() -> serde_json::Value {
    json!({"threadId":"thread","expectedTurnId":"turn","input":[{"type":"text","text":"synthetic"}]})
}

fn steer_options() -> CodexSteerRequestOptions<'static> {
    CodexSteerRequestOptions {
        prepare_delivery: async { Ok(()) }.boxed_local(),
        acknowledgement_timeout: Some(Duration::from_secs(1)),
    }
}

#[tokio::test]
async fn interrupt_acknowledgements_coalesce_and_cannot_reopen_a_finished_turn() {
    LocalSet::new()
        .run_until(async {
            for (mode, accepted, reopen) in [
                ("", true, false),
                ("interrupt-reject", false, true),
                ("interrupt-terminal-reject", false, false),
            ] {
                let fixture = Fixture::new(FIXTURE);
                let client = CodexAppServerClient::new(fixture.options(mode));
                let interrupt = Rc::new(CodexInterrupt::default());
                let detach = client.on_event(Rc::new({
                    let interrupt = interrupt.clone();
                    move |event| {
                        if matches!(event, CodexAppServerEvent::Notification(note) if note.method == "turn/completed") {
                            interrupt.clear();
                        }
                        Ok(())
                    }
                }));
                let logger = Rc::new(DiscoveryLogger::default());
                let reopened = Rc::new(Cell::new(false));
                let first = interrupt.begin(client.clone(), "thread".into(), "turn".into(), logger.clone(), {
                    let reopened = reopened.clone();
                    move || reopened.set(true)
                });
                let second = interrupt.begin(
                    client.clone(), "thread".into(), "turn".into(), logger.clone(),
                    || panic!("coalesced acknowledgement replaced the original"),
                );
                assert_eq!(tokio::join!(first, second), (accepted, accepted));
                assert_eq!(interrupt.current().is_some(), accepted);
                client.shutdown().await.unwrap();
                detach();
                assert_eq!(reopened.get(), reopen);
                let frames: Vec<_> = fixture.frames().into_iter()
                    .filter(|frame| frame["method"] == "turn/interrupt").collect();
                assert_eq!(frames.len(), 1);
                assert_eq!(frames[0]["params"], json!({"threadId":"thread","turnId":"turn"}));
                assert_eq!(logger.0.borrow().len(), usize::from(!accepted));
            }
        })
        .await;
}

fn settings_source(client: CodexAppServerClient, timeout: Duration) -> CodexSourceThreadSettings {
    let snapshot = serde_json::from_value(json!({
        "model":"m", "serviceTier":"default", "effort":"medium",
        "approvalPolicy":"never", "approvalsReviewer":"user",
        "sandboxPolicy":{"type":"workspaceWrite"},
    }))
    .unwrap();
    CodexSourceThreadSettings::new(
        client,
        "thread".into(),
        thread_settings_target_from_snapshot(&snapshot, PermissionMode::Default),
        true,
        timeout,
    )
}

fn settings_target() -> CodexThreadConfiguration {
    CodexThreadConfiguration {
        model: "m".into(),
        permission_mode: PermissionMode::ManualBypass,
        thinking_mode: Some(ThinkingMode::High),
    }
}

#[tokio::test]
async fn confirms_settings_when_notification_precedes_the_rpc_response() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options(""));
            let source = settings_source(client.clone(), Duration::from_secs(2));
            let detach = client.on_event(Rc::new({
                let source = source.clone();
                move |event| {
                    if let CodexAppServerEvent::Notification(note) = event
                        && note.method == "thread/settings/updated"
                    {
                        let params = note.params.as_ref().unwrap();
                        assert_eq!(params["threadId"], "thread");
                        assert_eq!(source.permission_mode(), PermissionMode::Default);
                        let settings: CodexThreadSettings =
                            serde_json::from_value(params["threadSettings"].clone()).unwrap();
                        source.handle_updated(&settings);
                    }
                    Ok(())
                }
            }));
            let target = settings_target();
            let result = source.update(&target);
            assert!(source.has_pending_configuration());
            result.await.unwrap();
            assert_eq!(source.permission_mode(), PermissionMode::ManualBypass);
            assert!(!source.provider_owns_effort());
            assert!(!source.has_pending_configuration());
            source.update(&target).await.unwrap();
            client.shutdown().await.unwrap();
            detach();
            let frames = fixture.frames();
            let mut updates = frames
                .iter()
                .filter(|frame| frame["method"] == "thread/settings/update");
            assert_eq!(
                updates.next().unwrap()["params"],
                json!({
                    "threadId":"thread", "model":"m", "approvalPolicy":"on-request",
                    "approvalsReviewer":"user", "sandboxPolicy":{
                        "type":"workspaceWrite","writableRoots":[],"networkAccess":false,
                        "excludeTmpdirEnvVar":false,"excludeSlashTmp":false,
                    }, "effort":"high",
                })
            );
            assert!(updates.next().is_none());
        })
        .await;
}

#[tokio::test]
async fn fences_a_settings_timeout_but_not_an_explicit_rpc_rejection() {
    LocalSet::new()
        .run_until(async {
            for (mode, expected_fence) in [("settings-failure", false), ("settings-timeout", true)]
            {
                let fixture = Fixture::new(FIXTURE);
                let client = CodexAppServerClient::new(fixture.options(mode));
                client.connect().await.unwrap();
                let source = settings_source(client.clone(), Duration::from_millis(80));
                let error = source.update(&settings_target()).await.unwrap_err();
                assert_eq!(source.is_fenced(), expected_fence);
                assert_eq!(source.permission_mode(), PermissionMode::Default);
                assert!(!source.has_pending_configuration());
                if expected_fence {
                    assert_eq!(
                        error.downcast_ref::<AgentIntegrationError>().unwrap().code,
                        AgentIntegrationErrorCode::TIMEOUT
                    );
                    let next = source.update(&settings_target()).await.unwrap_err();
                    assert_eq!(
                        next.downcast_ref::<AgentIntegrationError>().unwrap().code,
                        AgentIntegrationErrorCode::INVALID_SETTINGS
                    );
                } else {
                    assert_eq!(error.to_string(), "Synthetic settings failure");
                    assert!(error.is::<CodexAppServerRpcError>());
                }
                client.shutdown().await.unwrap();
            }
        })
        .await;
}

#[tokio::test]
async fn maps_a_native_turn_mismatch_without_retrying_another_turn() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options("steer-mismatch"));
            let error = client
                .steer_turn(&steer_params(), Some(steer_options()))
                .await
                .unwrap_err();
            let rpc = error.downcast_ref::<CodexAppServerRpcError>().unwrap();
            assert_eq!(
                classify_codex_steer_rejection(rpc),
                AgentSteerResult::Rejected {
                    reason: AgentSteerRejectionReason::TurnChanged,
                    message: "The active Codex turn changed".into(),
                }
            );
            client.shutdown().await.unwrap();
            let frames: Vec<_> = fixture
                .frames()
                .into_iter()
                .filter(|frame| frame["method"] == "turn/steer")
                .collect();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["params"]["expectedTurnId"], "turn");
        })
        .await;
}

fn utility_fixture(
    fixture: Rc<Fixture>,
    mode: &'static str,
    native_path: PathBuf,
) -> CodexAppServerUtility {
    CodexAppServerUtility::new(
        Rc::new(move || {
            let mut options = fixture.options(mode);
            options.env.insert(
                "SYNTHETIC_CODEX_NATIVE_PATH".into(),
                native_path.to_str().unwrap().into(),
            );
            CodexAppServerClient::new(options)
        }),
        Rc::new(DiscoveryLogger::default()),
        NativePathDiscoveryRefreshLimiter::default(),
    )
}

async fn original_utility_trace(
    fixture: &Fixture,
    native_path: &std::path::Path,
    mode: &str,
) -> String {
    let output = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/app-server-utility.ts"
        ))
        .arg(&fixture.command)
        .arg(native_path)
        .arg(&fixture.trace)
        .arg(mode)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let original = fs::read_to_string(&fixture.trace).unwrap();
    fs::remove_file(&fixture.trace).unwrap();
    original
}

#[tokio::test]
async fn utility_rejects_unsupported_requests_and_denies_unowned_approvals() {
    LocalSet::new().run_until(async {
        let fixture = Rc::new(Fixture::new(FIXTURE));
        let mode = "utility-server-requests";
        let original = original_utility_trace(&fixture, &fixture._directory.path().join("unused.jsonl"), mode).await;
        let logger = Rc::new(DiscoveryLogger::default());
        let utility = CodexAppServerUtility::new(
            Rc::new({
                let fixture = fixture.clone();
                move || CodexAppServerClient::new(fixture.options(mode))
            }),
            logger.clone(),
            NativePathDiscoveryRefreshLimiter::default(),
        );
        let result = tokio::time::timeout(Duration::from_secs(3), utility.resolve_native_path(Some("thread"))).await;
        utility.shutdown().await;
        assert_eq!(result.expect("utility did not answer the peer requests").unwrap(), None);
        assert_eq!(fs::read_to_string(&fixture.trace).unwrap(), original);
        let frames = fixture.frames();
        assert!(frames.contains(&json!({
            "id":"unsupported", "error":{"code":-32601,"message":"Unsupported Codex app-server request: synthetic/unknown"},
        })));
        assert!(frames.contains(&json!({"id":101,"result":{"decision":"cancel"}})));
        let mut warnings = logger.0.borrow().clone();
        warnings.sort();
        assert_eq!(warnings, [
            "Codex app-server emitted invalid JSON.",
            "Codex app-server stderr",
            "Dropped an unowned Codex approval request",
        ]);
    }).await;
}

#[tokio::test]
async fn retries_retryable_utility_app_server_overloads_and_reads_the_next_page() {
    LocalSet::new().run_until(async {
        let fixture = Rc::new(Fixture::new(FIXTURE));
        let path = fixture._directory.path().join("synthetic.jsonl");
        tokio::fs::write(&path, "{}\n").await.unwrap();
        let original = original_utility_trace(&fixture, &path, "utility-overload").await;
        let utility = utility_fixture(fixture.clone(), "utility-overload", path.clone());
        let (left, right) = tokio::join!(utility.resolve_native_path(Some("thread")), utility.resolve_native_path(Some("thread")));
        assert_eq!(left.unwrap().as_deref(), path.to_str());
        assert_eq!(right.unwrap().as_deref(), path.to_str());
        utility.shutdown().await;
        assert_eq!(fs::read_to_string(&fixture.trace).unwrap(), original);
        let frames = fixture.frames();
        assert_eq!(frames.iter().filter(|frame| frame["method"] == "initialize").count(), 1);
        let params: Vec<_> = frames.iter().filter(|frame| frame["method"] == "thread/list")
            .map(|frame| frame["params"].clone()).collect();
        let first = json!({
            "cursor":null, "limit":500, "sortKey":"updated_at", "sortDirection":"desc",
            "archived":false, "useStateDbOnly":false,
        });
        assert_eq!(params, [first.clone(), first.clone(), first.clone(), json!({
            "cursor":"second-page", "limit":500, "sortKey":"updated_at", "sortDirection":"desc",
            "archived":false, "useStateDbOnly":false,
        })]);
    }).await;
}

#[tokio::test]
async fn shares_cached_discovery_misses_until_an_explicit_refresh() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let path = fixture._directory.path().join("synthetic.jsonl");
            let utility = utility_fixture(fixture.clone(), "", path.clone());
            assert_eq!(utility.resolve_native_path(None).await.unwrap(), None);
            assert!(!fixture.trace.exists());
            assert_eq!(
                utility.resolve_native_path(Some("thread")).await.unwrap(),
                None
            );
            tokio::fs::write(&path, "{}\n").await.unwrap();
            assert_eq!(
                utility.resolve_native_path(Some("thread")).await.unwrap(),
                None
            );
            utility.request_native_path_discovery_refresh("thread");
            assert_eq!(
                utility
                    .resolve_native_path(Some("thread"))
                    .await
                    .unwrap()
                    .as_deref(),
                path.to_str()
            );
            utility.request_native_path_discovery_refresh("thread");
            assert_eq!(
                utility
                    .resolve_native_path(Some("thread"))
                    .await
                    .unwrap()
                    .as_deref(),
                path.to_str()
            );
            assert_eq!(
                fixture
                    .frames()
                    .iter()
                    .filter(|frame| frame["method"] == "thread/list")
                    .count(),
                2
            );
            utility.shutdown().await;
        })
        .await;
}

#[tokio::test]
async fn surfaces_thread_list_failures_and_discards_the_failed_snapshot() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let path = fixture._directory.path().join("synthetic.jsonl");
            tokio::fs::write(&path, "{}\n").await.unwrap();
            let utility = utility_fixture(fixture.clone(), "utility-error", path.clone());
            let error = utility
                .resolve_native_path(Some("thread"))
                .await
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<CodexAppServerRpcError>()
                    .unwrap()
                    .code
                    .0,
                -32603.0
            );
            assert_eq!(error.to_string(), "Synthetic discovery failed");
            assert_eq!(
                utility
                    .resolve_native_path(Some("thread"))
                    .await
                    .unwrap()
                    .as_deref(),
                path.to_str()
            );
            assert_eq!(
                fixture
                    .frames()
                    .iter()
                    .filter(|frame| frame["method"] == "thread/list")
                    .count(),
                2
            );
            utility.shutdown().await;
        })
        .await;
}

#[tokio::test]
async fn retires_an_exited_utility_client_and_never_respawns_after_shutdown() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let path = fixture._directory.path().join("synthetic.jsonl");
            tokio::fs::write(&path, "{}\n").await.unwrap();
            let utility = CodexAppServerUtility::new(
                Rc::new({
                    let fixture = fixture.clone();
                    let path = path.clone();
                    let starts = Cell::new(0);
                    move || {
                        let first = starts.get() == 0;
                        starts.set(starts.get() + 1);
                        let mut options = fixture.options(if first { "utility-exit" } else { "" });
                        options.env.insert(
                            "SYNTHETIC_CODEX_NATIVE_PATH".into(),
                            path.to_str().unwrap().into(),
                        );
                        CodexAppServerClient::new(options)
                    }
                }),
                Rc::new(DiscoveryLogger::default()),
                NativePathDiscoveryRefreshLimiter::default(),
            );
            let detached = utility
                .resolve_native_path(Some("thread"))
                .await
                .unwrap_err();
            assert_eq!(detached.to_string(), "Codex app-server exited with code 8");
            assert_eq!(
                utility
                    .resolve_native_path(Some("thread"))
                    .await
                    .unwrap()
                    .as_deref(),
                path.to_str()
            );
            utility.shutdown().await;
            assert_eq!(
                utility
                    .resolve_native_path(Some("thread"))
                    .await
                    .unwrap_err()
                    .to_string(),
                "Codex app-server client is shut down"
            );
            assert_eq!(
                fixture
                    .frames()
                    .iter()
                    .filter(|frame| frame["method"] == "initialize")
                    .count(),
                2
            );
        })
        .await;
}

#[derive(Default)]
struct DiscoveryLogger(RefCell<Vec<String>>);

impl AgentLogger for DiscoveryLogger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, message: &str, _: Option<&IndexMap<String, Opaque>>) {
        self.0.borrow_mut().push(message.to_owned());
    }
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

#[tokio::test]
async fn coalesces_skills_and_command_probes_by_project_and_clears_the_cache() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let discovery = CodexSkillDiscovery::new(
                Rc::new({
                    let fixture = fixture.clone();
                    move || CodexAppServerClient::new(fixture.options(""))
                }),
                Rc::new(DiscoveryLogger::default()),
            );
            let (commands, skills) =
                tokio::join!(discovery.commands("/repo"), discovery.skill_refs("/repo"));
            assert_eq!(commands.unwrap()[0].name, "verify");
            assert_eq!(skills.unwrap()[0].path, "/synthetic/verify");
            assert!(discovery.commands("/empty").await.unwrap().is_empty());
            assert_eq!(discovery.commands("/repo").await.unwrap().len(), 1);
            let requests = || {
                fixture
                    .frames()
                    .into_iter()
                    .filter(|frame| frame["method"] == "skills/list")
                    .count()
            };
            assert_eq!(requests(), 2);
            discovery.clear().await;
            assert_eq!(discovery.commands("/repo").await.unwrap().len(), 1);
            assert_eq!(requests(), 3);
        })
        .await;
}

#[tokio::test]
async fn clearing_a_pending_skill_probe_cannot_cache_its_empty_result() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let (signal, started) = oneshot::channel();
            let (release, gate) = oneshot::channel();
            let signal = Cell::new(Some(signal));
            let gate = Cell::new(Some(gate));
            let logger = Rc::new(DiscoveryLogger::default());
            let discovery = CodexSkillDiscovery::new(
                Rc::new({
                    let fixture = fixture.clone();
                    move || {
                        let mut options = fixture.options("");
                        if let Some(gate) = gate.take() {
                            let gate = Cell::new(Some(gate));
                            let signal = Cell::new(signal.take());
                            let resolve = options.resolve_cli.clone();
                            options.resolve_cli = Rc::new(move |env| {
                                signal.take().unwrap().send(()).unwrap();
                                let gate = gate.take().unwrap();
                                let command = resolve(env);
                                async move {
                                    gate.await?;
                                    command.await
                                }
                                .boxed_local()
                            });
                        }
                        CodexAppServerClient::new(options)
                    }
                }),
                logger.clone(),
            );
            let pending = tokio::task::spawn_local({
                let discovery = discovery.clone();
                async move { discovery.commands("/repo").await }
            });
            started.await.unwrap();
            discovery.clear().await;
            release.send(()).unwrap();
            assert!(pending.await.unwrap().unwrap().is_empty());
            assert_eq!(discovery.commands("/repo").await.unwrap()[0].name, "verify");
            assert_eq!(
                logger.0.borrow().as_slice(),
                ["Codex skills discovery failed"]
            );
        })
        .await;
}

#[tokio::test]
async fn rust_and_bun_send_the_same_startup_and_request_bytes() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new(FIXTURE);
        let oracle = tokio::process::Command::new("bun")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracles/app-server-client.ts"))
            .arg(&fixture.command).arg(&fixture.trace).output().await.unwrap();
        assert!(oracle.status.success(), "{}", String::from_utf8_lossy(&oracle.stderr));
        let original = fs::read_to_string(&fixture.trace).unwrap();
        fs::remove_file(&fixture.trace).unwrap();
        let mut options = fixture.options("");
        options.config = Some(json!({
            "model_providers":{"synthetic.provider":{"name":"fixture","supports_websockets":false}},
            "features":{"parallel":true}
        }));
        options.model_catalog_path = Some("/synthetic/catalog.json".into());
        let client = CodexAppServerClient::new(options);
        let (first, second) = tokio::join!(client.connect(), client.connect());
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(client.request("ping", Some(&serde_json::Value::Null), None).await.unwrap()["pong"], true);
        client.request("ping", Some(&json!({
            "label": "synthetic", "9": 1e-7, "2": 1e20, "rounded": 9007199254740993_u64,
        })), None).await.unwrap();
        let prepared = Rc::new(Cell::new(false));
        let options = CodexSteerRequestOptions {
            prepare_delivery: {
                let prepared = prepared.clone();
                let path = fixture.trace.clone();
                async move {
                    assert!(!fs::read_to_string(path).unwrap().contains("turn/steer"));
                    prepared.set(true);
                    Ok(())
                }.boxed_local()
            },
            ..steer_options()
        };
        assert_eq!(client.steer_turn(&steer_params(), Some(options)).await.unwrap()["turnId"], "turn");
        assert!(prepared.get());
        client.shutdown().await.unwrap();
        assert_eq!(fs::read_to_string(&fixture.trace).unwrap(), original);
    }).await;
}

#[tokio::test]
async fn speaks_to_the_original_integration_fake_app_server() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(INTEGRATION_FIXTURE);
            let client = CodexAppServerClient::new(fixture.options(""));
            let initialized = client.connect().await.unwrap();
            assert_eq!(initialized["userAgent"], "garcon/0.171.0 (synthetic)");
            let threads = client
                .request("thread/loaded/list", Some(&json!({})), None)
                .await
                .unwrap();
            assert_eq!(threads["data"], json!([]));
            client.shutdown().await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn managed_runtime_starts_a_session_and_publishes_rows_before_its_terminal_event() {
    LocalSet::new().run_until(async {
        let fixture = Rc::new(Fixture::new(INTEGRATION_FIXTURE));
        let rooted = fixture._directory.path().to_str().unwrap().to_owned();
        let factory = {
            let fixture = fixture.clone();
            let rooted = rooted.clone();
            Rc::new(move |env, _: Option<&garcon_agent_codex::runtime_types::CodexProviderConfig>| {
                let mut options = fixture.options("");
                options.env.insert("CODEX_HOME".into(), rooted.clone());
                options.env.insert("INTEGRATION_CODEX_STREAMING_TURN".into(), "1".into());
                if let Some(env) = env {
                    options.env.extend(env);
                }
                CodexAppServerClient::new(options)
            })
        };
        let mut options = CodexAppServerRuntimeOptions::new(factory, Rc::new(|| "synthetic-permission".into()));
        options.clock = Rc::new(ManualClock::new(0));
        let runtime = CodexAppServerRuntime::new(options);
        let (published, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let (activated, mut activation) = tokio::sync::mpsc::unbounded_channel();
        let operation = codex_operation("chat", "run", Rc::new(move |event| {
            let _ = published.send(event);
        }));
        let request = CodexStartRequest {
            execution: CodexExecutionRequest {
                activation: ThreadActivationSettings {
                    model: "synthetic-model".into(), project_path: rooted,
                    permission_mode: PermissionMode::Default, speed: None, codex_config: None,
                },
                thinking_mode: None, model_endpoint_id: None,
                client_message_id: Some("client-message".into()),
                admission: None, command: "synthetic input".into(), images: Vec::new(),
                env_overrides: None, operation,
            },
            on_session_activated: Some(Rc::new(move |session| { let _ = activated.send(session); })),
        };
        let result = tokio::time::timeout(Duration::from_secs(4), runtime.start_session(request))
            .await.expect("start deadline").expect("managed session");
        assert_eq!(activation.try_recv().unwrap(), result);
        assert!(tokio::fs::metadata(result.native_path.as_deref().unwrap()).await.unwrap().is_file());
        tokio::time::timeout(Duration::from_secs(4), async {
            let mut steerable = 0;
            let mut assistant_count = 0;
            loop {
                let event = receive.recv().await.expect("managed runtime sender closed before terminal");
                match event {
                    AgentRuntimeEvent::Steerable => steerable += 1,
                    AgentRuntimeEvent::Rows { rows } => {
                        assistant_count += rows.iter().filter(|row| matches!(row.message, ChatMessage::Assistant(_))).count();
                    }
                    AgentRuntimeEvent::RunEnded { run_id, outcome, .. } => {
                        assert_eq!(run_id, "run");
                        assert!(matches!(outcome, ProviderRunOutcome::Finished { .. }));
                        assert_eq!(steerable, 1);
                        assert_eq!(assistant_count, 2);
                        break;
                    }
                    _ => panic!("unexpected managed runtime event"),
                }
            }
        }).await.expect("terminal deadline");
        assert!(!runtime.is_running(&result.agent_session_id));
        runtime.release_session("chat", Some(&result.agent_session_id)).await;
        runtime.shutdown().await;
    }).await;
}

#[tokio::test]
async fn managed_steering_waits_for_acknowledgement_before_publishing_the_terminal_event() {
    LocalSet::new()
        .run_until(async {
            let fixture = Rc::new(Fixture::new(FIXTURE));
            let path = fixture._directory.path();
            let native_path = path.join("rollout.jsonl");
            let release = path.join("release-steer");
            tokio::fs::write(&native_path, "{}\n").await.unwrap();
            let factory = {
                let fixture = fixture.clone();
                let release = release.clone();
                Rc::new(
                    move |_, _: Option<&garcon_agent_codex::runtime_types::CodexProviderConfig>| {
                        let mut options = fixture.options("managed-steer-terminal");
                        options.env.insert(
                            "SYNTHETIC_CODEX_NATIVE_PATH".into(),
                            native_path.to_str().unwrap().into(),
                        );
                        options.env.insert(
                            "SYNTHETIC_CODEX_STEER_RELEASE".into(),
                            release.to_str().unwrap().into(),
                        );
                        CodexAppServerClient::new(options)
                    },
                )
            };
            let runtime = CodexAppServerRuntime::new(CodexAppServerRuntimeOptions::new(
                factory,
                Rc::new(|| "synthetic-occurrence".into()),
            ));
            let (publish, mut events) = tokio::sync::mpsc::unbounded_channel();
            runtime
                .start_session(CodexStartRequest {
                    execution: CodexExecutionRequest {
                        activation: ThreadActivationSettings {
                            model: "synthetic-model".into(),
                            project_path: path.to_str().unwrap().into(),
                            permission_mode: PermissionMode::Default,
                            speed: None,
                            codex_config: None,
                        },
                        thinking_mode: None,
                        model_endpoint_id: None,
                        client_message_id: None,
                        admission: None,
                        command: "first".into(),
                        images: vec![],
                        env_overrides: None,
                        operation: codex_operation(
                            "chat",
                            "run",
                            Rc::new(move |event| {
                                let _ = publish.send(event);
                            }),
                        ),
                    },
                    on_session_activated: None,
                })
                .await
                .unwrap();
            assert!(matches!(
                events.try_recv().unwrap(),
                AgentRuntimeEvent::Steerable
            ));
            let target = runtime.capture_steer_target("thread").unwrap();
            let reply = AsyncQuestionReply {
                question_id: "synthetic-question".into(),
                question: "Which one?".into(),
                answer: "The first.".into(),
                source: None,
            };
            let request = RuntimeSteerRequest {
                chat_id: "chat".into(),
                project_path: path.to_str().unwrap().into(),
                agent_session_id: "thread".into(),
                native_session: None,
                target: Some(target),
                input: async_question_reply_text(&reply),
                question_reply: Some(reply),
                client_message_id: "steer".into(),
                prepare_delivery: Rc::new(|| async { Ok(()) }.boxed_local()),
            };
            let in_flight = tokio::task::spawn_local({
                let runtime = runtime.clone();
                async move { runtime.steer(request).await }
            });
            let rows = tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .unwrap()
                .unwrap();
            let premature_terminal = events.try_recv().is_ok();
            let still_completing = runtime
                .running_sessions()
                .iter()
                .any(|session| session.status.as_deref() == Some("completing"));
            tokio::fs::write(&release, "").await.unwrap();
            assert!(matches!(rows, AgentRuntimeEvent::Rows { .. }));
            assert!(
                !premature_terminal && still_completing,
                "terminal must wait for the delivery reservation"
            );
            assert_eq!(
                in_flight.await.unwrap().unwrap(),
                AgentSteerResult::Accepted
            );
            let terminal = events.try_recv().unwrap();
            assert!(matches!(
                terminal,
                AgentRuntimeEvent::RunEnded { run_id, outcome: ProviderRunOutcome::Finished {
                    final_response: Some(AgentFinalResponse::Text { text })
                }, .. } if run_id == "run" && text == "Final answer."
            ));
            assert!(!runtime.is_running("thread"));
            let frames = fixture.frames();
            let steer = frames
                .iter()
                .find(|frame| frame["method"] == "turn/steer")
                .unwrap();
            assert_eq!(steer["params"]["expectedTurnId"], "turn");
            assert_eq!(steer["params"]["clientUserMessageId"], "steer");
            assert!(
                steer["params"]["input"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("<send_user_message_question_reply>")
            );
            runtime.shutdown().await;
        })
        .await;
}

#[tokio::test]
async fn managed_capacity_retry_starts_an_empty_turn_on_the_original_operation() {
    LocalSet::new().run_until(async {
        let fixture = Rc::new(Fixture::new(FIXTURE));
        let path = fixture._directory.path();
        let native_path = path.join("rollout.jsonl");
        tokio::fs::write(&native_path, "{}\n").await.unwrap();
        let factory = {
            let fixture = fixture.clone();
            Rc::new(move |_, _: Option<&garcon_agent_codex::runtime_types::CodexProviderConfig>| {
                let mut options = fixture.options("capacity-retry");
                options.env.insert("SYNTHETIC_CODEX_NATIVE_PATH".into(), native_path.to_str().unwrap().into());
                CodexAppServerClient::new(options)
            })
        };
        let mut options = CodexAppServerRuntimeOptions::new(factory, Rc::new(|| "synthetic-occurrence".into()));
        options.capacity_retry_delays = vec![Duration::ZERO];
        let runtime = CodexAppServerRuntime::new(options);
        let (publish, mut events) = tokio::sync::mpsc::unbounded_channel();
        runtime.start_session(CodexStartRequest {
            execution: CodexExecutionRequest {
                activation: ThreadActivationSettings {
                    model: "synthetic-model".into(), project_path: path.to_str().unwrap().into(),
                    permission_mode: PermissionMode::Default, speed: None, codex_config: None,
                },
                thinking_mode: None, model_endpoint_id: None, client_message_id: Some("initial".into()),
                admission: None, command: "first input".into(), images: vec![], env_overrides: None,
                operation: codex_operation("chat", "original-run", Rc::new(move |event| { let _ = publish.send(event); })),
            },
            on_session_activated: None,
        }).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut steerable = 0;
            let mut rows_count = 0;
            loop {
                match events.recv().await.unwrap() {
                    AgentRuntimeEvent::Steerable => steerable += 1,
                    AgentRuntimeEvent::Rows { rows } => rows_count += rows.len(),
                    AgentRuntimeEvent::RunEnded { run_id, outcome, .. } => {
                        assert_eq!(run_id, "original-run");
                        assert!(matches!(
                            outcome,
                            ProviderRunOutcome::Finished { final_response: Some(AgentFinalResponse::Text { text }) }
                                if text == "Recovered."
                        ));
                        assert_eq!(steerable, 2);
                        assert_eq!(rows_count, 2);
                        break;
                    }
                    _ => panic!("unexpected managed capacity event"),
                }
            }
        }).await.unwrap();
        assert!(events.try_recv().is_err());
        let frames = fixture.frames();
        let starts: Vec<_> = frames.iter().filter(|frame| frame["method"] == "turn/start").collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0]["params"]["input"][0]["text"], "first input");
        assert_eq!(starts[0]["params"]["clientUserMessageId"], "initial");
        assert_eq!(
            starts[1]["params"],
            json!({"threadId":"thread","input":[],"serviceTierForTurn":"default"}),
            "retry sends no user input",
        );
        runtime.shutdown().await;
    }).await;
}

#[tokio::test]
async fn dispatches_rpc_failures_and_string_ids_and_continues_after_a_listener_fails() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new(FIXTURE);
        let client = CodexAppServerClient::new(fixture.options(""));
        let events = Rc::new(RefCell::new(Vec::new()));
        let unsubscribe = client.on_event(Rc::new({
            let events = events.clone();
            let client = client.clone();
            move |event| {
                events.borrow_mut().push(event.clone());
                match event {
                    CodexAppServerEvent::Notification(value) if value.method == "one" => {
                        Err(std::io::Error::other("synthetic listener error").into())
                    }
                    CodexAppServerEvent::ServerRequest(request) => {
                        assert_eq!(request.id, JsonRpcId::String("string-id".into()));
                        client.respond(&request.id, &json!({"decision":"decline"}))
                    }
                    _ => Ok(()),
                }
            }
        }));
        client.request("send-events", None::<&serde_json::Value>, None).await.unwrap();
        let error = client.request("bad", None::<&serde_json::Value>, None).await.unwrap_err();
        let rpc = error.downcast_ref::<CodexAppServerRpcError>().unwrap();
        assert_eq!(rpc.code.0, -32001.0);
        assert_eq!(rpc.message, "Synthetic RPC error");
        assert_eq!(rpc.data.as_ref().unwrap()["reason"], "synthetic");
        client.shutdown().await.unwrap();
        unsubscribe();
        assert!(fixture.frames().iter().any(|frame| frame == &json!({"id":"string-id","result":{"decision":"decline"}})));
        let events = events.borrow();
        assert!(events.iter().any(|event| matches!(event, CodexAppServerEvent::Notification(value) if value.method == "two")));
        assert!(events.iter().any(|event| matches!(event, CodexAppServerEvent::Metric(CodexAppServerMetric::Request { method, success: false, .. }) if method == "bad")));
        let warnings: Vec<_> = events.iter().filter_map(|event| match event {
            CodexAppServerEvent::Warning(text) => Some(text.as_str()),
            _ => None,
        }).collect();
        assert_eq!(warnings, ["Codex app-server emitted invalid JSON.", "Codex app-server message handler failed: synthetic listener error"]);
    }).await;
}

#[tokio::test]
async fn keeps_late_responses_from_satisfying_later_requests() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options("delay"));
            let (warn, warning) = oneshot::channel();
            let warn = Cell::new(Some(warn));
            let _unsubscribe = client.on_event(Rc::new(move |event| {
                if let CodexAppServerEvent::Warning(message) = event
                    && let Some(sender) = warn.take()
                {
                    let _ = sender.send(message.clone());
                }
                Ok(())
            }));
            let error = client
                .request(
                    "stall",
                    None::<&serde_json::Value>,
                    Some(Duration::from_millis(5)),
                )
                .await
                .unwrap_err();
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            assert_eq!(error.code, AgentIntegrationErrorCode::TIMEOUT);
            assert!(error.retryable);
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), warning)
                    .await
                    .unwrap()
                    .unwrap(),
                "Ignoring late Codex app-server response: 2"
            );
            let options = CodexSteerRequestOptions {
                acknowledgement_timeout: Some(Duration::from_millis(5)),
                ..steer_options()
            };
            let error = client
                .steer_turn(&steer_params(), Some(options))
                .await
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<CodexAppServerDeliveryError>()
                    .unwrap()
                    .outcome,
                CodexDeliveryOutcome::Unknown
            );
            assert_eq!(
                client
                    .request("ping", None::<&serde_json::Value>, None)
                    .await
                    .unwrap()["pong"],
                true
            );
            client.shutdown().await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn distinguishes_steering_serialization_failure_from_native_exit() {
    #[derive(Debug)]
    struct InvalidFrame;
    impl Serialize for InvalidFrame {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("synthetic serialization failure"))
        }
    }
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options("exit"));
            let prepared = Rc::new(Cell::new(false));
            let options = CodexSteerRequestOptions {
                prepare_delivery: {
                    let prepared = prepared.clone();
                    async move {
                        prepared.set(true);
                        Ok(())
                    }
                    .boxed_local()
                },
                ..steer_options()
            };
            let error = client
                .steer_turn(&InvalidFrame, Some(options))
                .await
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<CodexAppServerDeliveryError>()
                    .unwrap()
                    .outcome,
                CodexDeliveryOutcome::NotSent
            );
            assert!(!prepared.get());
            let error = client
                .steer_turn(&steer_params(), Some(steer_options()))
                .await
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<CodexAppServerDeliveryError>()
                    .unwrap()
                    .outcome,
                CodexDeliveryOutcome::Unknown
            );
            assert!(
                fixture
                    .frames()
                    .iter()
                    .any(|frame| frame["method"] == "turn/steer")
            );
            client.shutdown().await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn does_not_spawn_after_shutdown_during_resolution() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let (resolver_started, started) = oneshot::channel();
            let (release, gate) = oneshot::channel::<ResolvedCodexCli>();
            let gate = Cell::new(Some(gate));
            let notify = Cell::new(Some(resolver_started));
            let mut options = fixture.options("");
            options.resolve_cli = Rc::new(move |_| {
                notify.take().unwrap().send(()).unwrap();
                let gate = gate.take().unwrap();
                async move { Ok(gate.await?) }.boxed_local()
            });
            let client = CodexAppServerClient::new(options);
            let connect = tokio::task::spawn_local({
                let client = client.clone();
                async move { client.connect().await }
            });
            started.await.unwrap();
            client.shutdown().await.unwrap();
            release
                .send(ResolvedCodexCli {
                    command: fixture.command.to_str().unwrap().into(),
                    source: CodexCommandSource::Env,
                })
                .unwrap();
            assert_eq!(
                connect.await.unwrap().unwrap_err().to_string(),
                "Codex app-server client is shut down"
            );
            assert!(!fixture.trace.exists());
        })
        .await;
}

#[tokio::test]
async fn retires_a_peer_that_rejected_initialization_before_spawning_a_retry() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let mut options = fixture.options("retry");
            options.shutdown_grace = Duration::from_secs(1);
            let client = CodexAppServerClient::new(options);
            let error = client.connect().await.unwrap_err();
            assert_eq!(error.to_string(), "Synthetic initialization failure");
            assert!(error.is::<CodexAppServerRpcError>());
            let (first, second) = tokio::join!(client.connect(), client.connect());
            assert_eq!(first.unwrap(), second.unwrap());
            client.shutdown().await.unwrap();
            let frames = fixture.frames();
            assert_eq!(frames[1]["id"], 1);
            assert_eq!(frames[2]["closed"], true);
            assert!(frames[3]["argv"].is_array());
            assert_eq!(frames[4]["id"], 2);
            assert_eq!(frames[5]["method"], "initialized");
            assert_eq!(frames[6]["closed"], true);
        })
        .await;
}

#[tokio::test]
async fn closes_an_incompatible_peer_and_escalates_only_if_eof_does_not_end_it() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new(FIXTURE);
            let client = CodexAppServerClient::new(fixture.options("old"));
            assert!(
                client
                    .connect()
                    .await
                    .unwrap_err()
                    .is::<IncompatibleCodex>()
            );
            assert!(
                client
                    .connect()
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("shut down")
            );

            let mut options = fixture.options("stubborn");
            options.shutdown_grace = Duration::from_millis(25);
            options.shutdown_terminate = Duration::from_millis(25);
            options.shutdown_kill = Duration::from_secs(2);
            let client = CodexAppServerClient::new(options);
            let exit = Rc::new(Cell::new(None));
            let _unsubscribe = client.on_event(Rc::new({
                let exit = exit.clone();
                move |event| {
                    if let CodexAppServerEvent::Exit(code) = event {
                        exit.set(Some(*code));
                    }
                    Ok(())
                }
            }));
            client.connect().await.unwrap();
            let (first, second) = tokio::join!(client.shutdown(), client.shutdown());
            first.unwrap();
            second.unwrap();
            assert_eq!(exit.get(), Some(137));
        })
        .await;
}
