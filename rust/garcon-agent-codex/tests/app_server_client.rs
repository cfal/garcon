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
    protocol::JsonRpcId,
    request_builders::{
        CodexThreadConfiguration, CodexThreadSettings, thread_settings_target_from_snapshot,
    },
    runtime::{
        interrupt::CodexInterrupt, thread_settings::CodexSourceThreadSettings,
        utility::CodexAppServerUtility,
    },
    steering::classify_codex_steer_rejection,
};
use garcon_agent_codex::slash_command_discovery::CodexSkillDiscovery;
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::host::AgentLogger;
use garcon_interface::services::{AgentSteerRejectionReason, AgentSteerResult};
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
