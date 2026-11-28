use std::{cell::RefCell, path::Path, rc::Rc};

use super::ClaudeAgentIntegration;
use futures::TryStreamExt;
use garcon_agents_common::direct::conformance_host::conformance_host;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::{AgentEnvironmentReader, AgentHost},
    integration::AgentIntegrationClass,
    native_fork::{AgentNativeForkOutcome, AgentNativeForkRequest},
    native_history::{AgentHistoryImport, AgentHistoryImportRequest},
    resources::ExecutorResult,
    testing::{AgentIntegrationConformanceOptions, run_agent_integration_conformance},
    transcript::{AgentChatReference, AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use indexmap::IndexMap;
use serde_json::json;
use tokio::{fs, task::LocalSet};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Environment {
    reads: RefCell<Vec<String>>,
    values: IndexMap<String, String>,
    fail: Option<&'static str>,
}

impl AgentEnvironmentReader for Environment {
    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        self.reads.borrow_mut().push(name.into());
        if self.fail == Some(name) {
            return Err(format!("Synthetic environment read failure: {name}").into());
        }
        Ok(self.values.get(name).cloned())
    }
}

fn host(root: &Path, environment: Rc<Environment>) -> AgentHost {
    let mut host = conformance_host("claude", root).unwrap();
    host.environment = environment;
    host
}

#[tokio::test]
async fn integration_conforms_without_environment_access_during_construction() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let environment = Rc::new(Environment::default());
            let class = ClaudeAgentIntegration;
            let integration = class.create(host(root.path(), environment.clone()));
            assert!(environment.reads.borrow().is_empty());
            run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                integration_id: class.integration_id(),
                api_version: class.api_version(),
                integration: &integration,
            })
            .await
            .unwrap();
        })
        .await;
}

async fn read_history(
    importer: &dyn AgentHistoryImport,
    chat: AgentChatReference,
) -> ExecutorResult<Vec<ChatMessage>> {
    let batches: Vec<_> = importer
        .load(
            AgentHistoryImportRequest {
                chat,
                signal: CancellationToken::new(),
            },
            None,
        )
        .try_collect()
        .await?;
    Ok(batches
        .into_iter()
        .flatten()
        .map(|row| row.message)
        .collect())
}

#[tokio::test]
async fn lazy_native_history_resolves_a_stale_path_and_keeps_strict_and_legacy_errors_distinct() {
    let root = tempfile::tempdir().unwrap();
    let environment = Rc::new(Environment {
        values: IndexMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            root.path().to_string_lossy().into_owned(),
        )]),
        ..Default::default()
    });
    let integration = ClaudeAgentIntegration.create(host(root.path(), environment.clone()));
    let recorded = root
        .path()
        .join("projects")
        .join("synthetic-moved-project")
        .join("synthetic-session.jsonl");
    let stale = root.path().join("synthetic-stale.jsonl");
    let chat = AgentChatReference {
        chat_id: "synthetic-chat".into(),
        agent_id: "claude".into(),
        agent_session_id: Some("synthetic-session".into()),
        project_path: root.path().to_string_lossy().into_owned(),
        model: "haiku".into(),
        native_session: Some(AgentNativeSessionRef {
            owner_id: "claude".into(),
            schema_version: 1,
            value: json!({"path":stale,"agentSessionId":"synthetic-session"}).into(),
        }),
        native_seed_receipt: None,
        carry_over_revision: String::new(),
        settings: integration.settings.defaults().unwrap(),
    };
    assert!(environment.reads.borrow().is_empty());
    let native = integration.native_history_import.as_deref().unwrap();
    let legacy = integration.legacy_history_import.as_deref().unwrap();
    assert!(read_history(legacy, chat.clone()).await.unwrap().is_empty());
    let error = read_history(native, chat.clone()).await.unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(
        error.code,
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
    );
    assert_eq!(error.details.as_ref().unwrap()["reason"], "source-missing");
    let forking = integration.forking.as_ref().unwrap();
    let fork_request = AgentNativeForkRequest {
        chat_id: "synthetic-fork".into(),
        project_path: chat.project_path.clone(),
        model: chat.model.clone(),
        permission_mode: garcon_contract::chat_modes::PermissionMode::Default,
        thinking_mode: garcon_contract::chat_modes::ThinkingMode::None,
        settings: chat.settings.clone(),
        endpoint: None,
        signal: CancellationToken::new(),
        source: chat.clone(),
        provider_meta: Some(
            json!({"entryId":"synthetic-user","lineNumber":1,"withinSourceOrdinal":0}).into(),
        ),
    };
    let error = forking.fork(fork_request.clone(), None).await.unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(
        error.code,
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
    );
    assert!(error.retryable);
    assert_eq!(
        error.details.as_ref().unwrap()["nativeForkReason"],
        "source-missing"
    );

    fs::create_dir_all(recorded.parent().unwrap())
        .await
        .unwrap();
    fs::write(&recorded, r#"{"type":"user","sessionId":"synthetic-session","uuid":"synthetic-user","message":{"role":"user","content":"synthetic history"}}"#).await.unwrap();

    for importer in [legacy, native] {
        let rows = read_history(importer, chat.clone()).await.unwrap();
        assert!(
            matches!(&rows[..], [ChatMessage::User(user)] if user.content == "synthetic history")
        );
    }
    let outcome = forking.fork(fork_request, None).await.unwrap();
    let AgentNativeForkOutcome::Materialized { session } = outcome else {
        panic!("expected a materialized native fork");
    };
    let fork_path = session.native_session.as_ref().unwrap().value["path"]
        .as_str()
        .unwrap();
    assert_ne!(Path::new(fork_path), recorded);
    let forked = read_history(
        native,
        AgentChatReference {
            chat_id: "synthetic-fork".into(),
            agent_session_id: Some(session.agent_session_id.clone()),
            native_session: session.native_session.clone(),
            ..chat.clone()
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(&forked[..], [ChatMessage::User(user)] if user.content == "synthetic history")
    );
    forking
        .discard(session.clone(), CancellationToken::new(), None)
        .await
        .unwrap();
    assert!(!fs::try_exists(fork_path).await.unwrap());
    assert!(fs::try_exists(&recorded).await.unwrap());

    assert_eq!(
        integration
            .native_sessions
            .as_ref()
            .unwrap()
            .describe_source(AgentHistoryImportRequest {
                chat: chat.clone(),
                signal: CancellationToken::new(),
            })
            .await
            .unwrap(),
        Some(AgentTranscriptSourceLocation::FilesystemPath {
            value: recorded.to_string_lossy().into_owned()
        }),
    );
    fs::write(&recorded, r#"{"type":"user","sessionId":"synthetic-session","message":{"role":"user","content":[{"type":"text"}]}}"#).await.unwrap();
    for importer in [legacy, native] {
        assert_eq!(
            read_history(importer, chat.clone())
                .await
                .unwrap_err()
                .to_string(),
            "Claude transcript record 1 has an invalid message part",
        );
    }
}

#[tokio::test]
async fn environment_errors_surface_at_the_facet_that_reads_them() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let environment = Rc::new(Environment {
                fail: Some("CLAUDE_BINARY"),
                ..Default::default()
            });
            let integration = ClaudeAgentIntegration.create(host(root.path(), environment.clone()));
            let auth = integration.auth.as_ref().unwrap();
            let login = auth.login_capabilities();
            let launch = login.launch_login.as_ref().unwrap();
            let commands = integration.commands.as_ref().unwrap();
            let project = root.path().to_str().unwrap();
            assert!(environment.reads.borrow().is_empty());
            assert_eq!(
                commands
                    .discover(project, CancellationToken::new())
                    .await
                    .unwrap_err()
                    .to_string(),
                "Synthetic environment read failure: CLAUDE_BINARY",
            );
            assert_eq!(
                launch.launch_login().await.unwrap_err().to_string(),
                "Synthetic environment read failure: CLAUDE_BINARY",
            );
            assert_eq!(
                *environment.reads.borrow(),
                ["CLAUDE_BINARY", "CLAUDE_BINARY"]
            );
            let status = auth.status(CancellationToken::new()).await.unwrap();
            assert!(!status.authenticated);
            assert!(status.can_reauth);
            assert_eq!(status.label, "Claude");
            assert_eq!(
                *environment.reads.borrow(),
                [
                    "CLAUDE_BINARY",
                    "CLAUDE_BINARY",
                    "ANTHROPIC_BASE_URL",
                    "ANTHROPIC_API_KEY",
                    "CLAUDE_BINARY"
                ]
            );
            integration.lifecycle.start().await.unwrap();
            integration.lifecycle.stop().await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn validates_model_annotations_without_a_native_session() {
    use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
    use garcon_interface::execution::AgentSessionConfiguration;

    let root = tempfile::tempdir().unwrap();
    let environment = Rc::new(Environment::default());
    let integration = ClaudeAgentIntegration.create(host(root.path(), environment.clone()));
    let validation = integration.configuration_validation.as_ref().unwrap();
    let configuration = AgentSessionConfiguration {
        model: "custom[922k]".into(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        settings: integration.settings.defaults().unwrap(),
        endpoint: None,
    };
    validation
        .validate(configuration.clone(), None)
        .await
        .unwrap();
    let error = validation
        .validate(
            AgentSessionConfiguration {
                model: "custom[99k]".into(),
                ..configuration
            },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<AgentIntegrationError>().unwrap().code,
        AgentIntegrationErrorCode::INVALID_SETTINGS
    );
    assert!(environment.reads.borrow().is_empty());
}

#[tokio::test]
async fn usage_history_propagates_a_lazy_config_directory_read_failure() {
    use garcon_contract::usage::UsageReadRequest;
    use garcon_interface::usage_history::AgentUsageReadRequest;

    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let environment = Rc::new(Environment {
                fail: Some("CLAUDE_CONFIG_DIR"),
                ..Default::default()
            });
            let integration = ClaudeAgentIntegration.create(host(root.path(), environment.clone()));
            let usage = integration.usage_history.as_ref().unwrap();
            assert!(environment.reads.borrow().is_empty());
            let error = usage
                .read(AgentUsageReadRequest {
                    request: UsageReadRequest {
                        since_day: "2026-07-20".into(),
                        until_day: "2026-07-21".into(),
                        time_zone: "UTC".into(),
                    },
                    signal: Some(CancellationToken::new()),
                })
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Synthetic environment read failure: CLAUDE_CONFIG_DIR"
            );
            assert_eq!(*environment.reads.borrow(), ["CLAUDE_CONFIG_DIR"]);
        })
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn single_query_uses_the_configured_binary_and_removes_its_isolated_directory() {
    use std::os::unix::fs::PermissionsExt;

    use garcon_contract::chat_modes::ThinkingMode;
    use garcon_interface::services::AgentSingleQueryRequest;
    use garcon_js::Number;

    LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("fake-claude-query");
        fs::write(&binary, r#"#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\n' '2.1.238 (Claude Code)'
  exit 0
fi
[ "$*" = '--print --no-session-persistence --model haiku --permission-mode default -p synthetic prompt' ] || exit 3
printf '%s\n' "$PWD" > "$CLAUDE_CONFIG_DIR/query-cwd"
printf ' synthetic answer \n'
"#).await.unwrap();
        fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        let environment = Rc::new(Environment {
            values: IndexMap::from([
                ("CLAUDE_BINARY".into(), binary.to_string_lossy().into_owned()),
                ("CLAUDE_CONFIG_DIR".into(), root.path().to_string_lossy().into_owned()),
            ]),
            ..Default::default()
        });
        let integration = ClaudeAgentIntegration.create(host(root.path(), environment));
        let facet = integration.single_query.as_ref().unwrap();
        assert!(!facet.runs_tools_without_permission());
        let answer = facet.run(AgentSingleQueryRequest {
            prompt: "synthetic prompt".into(),
            model: "haiku".into(),
                    thinking_mode: ThinkingMode::None,
            timeout_ms: Some(Number(5_000.0)),
            settings: integration.settings.defaults().unwrap(),
            endpoint: None,
            signal: CancellationToken::new(),
        }).await.unwrap();
            assert_eq!(answer, " synthetic answer \n");
        let cwd = fs::read_to_string(root.path().join("query-cwd")).await.unwrap();
        let directory = Path::new(cwd.trim_end());
        assert!(directory.file_name().unwrap().to_string_lossy().starts_with("garcon-single-query-"));
        assert!(!fs::try_exists(directory).await.unwrap());
    }).await;
}
