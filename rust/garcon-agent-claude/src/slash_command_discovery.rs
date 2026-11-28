use std::{cell::RefCell, collections::HashSet, ffi::OsString, rc::Rc, time::Duration};

use futures::future::{FutureExt, LocalBoxFuture, Shared};
use garcon_contract::slash_commands::{SlashCommand, SlashCommandSource};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{Clock, SystemClock, collation::Collation, json::Opaque};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::cli_process_transport::{
    ClaudeProcessOptions, ClaudeProcessTransport, ClaudeProcessTransportOptions,
    spawn_claude_subprocess,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const CACHE_TTL_MS: i64 = 5 * 60_000;
const EMPTY_CACHE_TTL_MS: i64 = 5_000;

pub fn parse_init_slash_commands(slash_commands: &Value, skills: &Value) -> Vec<SlashCommand> {
    let skill_names: HashSet<&str> = skills
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let Some(slash_commands) = slash_commands.as_array() else {
        return Vec::new();
    };

    let mut commands: Vec<_> = slash_commands
        .iter()
        .filter_map(|value| {
            let (name, description, explicit_skill) = match value {
                Value::String(name) => (name.as_str(), None, false),
                Value::Object(fields) => (
                    fields.get("name")?.as_str()?,
                    fields
                        .get("description")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned),
                    fields.get("type").and_then(Value::as_str) == Some("skill"),
                ),
                _ => return None,
            };
            // A native clear would discard context that the ledger still describes.
            if name == "clear" {
                return None;
            }
            let source = if explicit_skill || skill_names.contains(name) {
                SlashCommandSource::Skill
            } else {
                SlashCommandSource::Command
            };
            Some(SlashCommand {
                name: name.to_owned(),
                source,
                description,
            })
        })
        .collect();
    commands.sort_by(|left, right| Collation::english().compare(&left.name, &right.name));
    commands
}

type CommandExecutable = dyn Fn() -> ExecutorResult<OsString>;
type CommandEnvironment = dyn Fn() -> ExecutorResult<IndexMap<OsString, OsString>>;
type Discovery = Shared<LocalBoxFuture<'static, Vec<SlashCommand>>>;

struct CacheEntry {
    commands: Vec<SlashCommand>,
    expires_at: i64,
}

struct DiscoveryState {
    binary: Rc<CommandExecutable>,
    environment: Rc<CommandEnvironment>,
    logger: Rc<dyn AgentLogger>,
    clock: Rc<dyn Clock>,
    new_request_id: Rc<dyn Fn() -> String>,
    cache: RefCell<IndexMap<String, CacheEntry>>,
    in_flight: RefCell<IndexMap<String, Discovery>>,
}

pub struct ClaudeSlashCommandDiscovery(Rc<DiscoveryState>);

impl ClaudeSlashCommandDiscovery {
    pub fn new(
        binary: Rc<CommandExecutable>,
        environment: Rc<CommandEnvironment>,
        logger: Rc<dyn AgentLogger>,
    ) -> Self {
        Self::with_clock_and_ids(
            binary,
            environment,
            logger,
            Rc::new(SystemClock),
            Rc::new(|| uuid::Uuid::new_v4().to_string()),
        )
    }

    pub fn with_clock_and_ids(
        binary: Rc<CommandExecutable>,
        environment: Rc<CommandEnvironment>,
        logger: Rc<dyn AgentLogger>,
        clock: Rc<dyn Clock>,
        new_request_id: Rc<dyn Fn() -> String>,
    ) -> Self {
        Self(Rc::new(DiscoveryState {
            binary,
            environment,
            logger,
            clock,
            new_request_id,
            cache: RefCell::default(),
            in_flight: RefCell::default(),
        }))
    }

    pub async fn discover(&self, project_path: &str) -> ExecutorResult<Vec<SlashCommand>> {
        if let Some(cached) = self.0.cache.borrow().get(project_path)
            && cached.expires_at > self.0.clock.now_ms()
        {
            return Ok(cached.commands.clone());
        }
        let existing = self.0.in_flight.borrow().get(project_path).cloned();
        if let Some(existing) = existing {
            return Ok(existing.await);
        }

        let binary = (self.0.binary)()?;
        let env_overrides = (self.0.environment)()?;
        let logger = self.0.logger.clone();
        let id = (self.0.new_request_id)();
        let project_path = project_path.to_owned();
        let probe_path = project_path.clone();
        let state = Rc::downgrade(&self.0);
        let probe = async move {
            let commands =
                probe_claude_slash_commands(&probe_path, binary, env_overrides, logger, id).await;
            if let Some(state) = state.upgrade() {
                let ttl = if commands.is_empty() {
                    EMPTY_CACHE_TTL_MS
                } else {
                    CACHE_TTL_MS
                };
                state.cache.borrow_mut().insert(
                    probe_path.clone(),
                    CacheEntry {
                        commands: commands.clone(),
                        expires_at: state.clock.now_ms() + ttl,
                    },
                );
                state.in_flight.borrow_mut().shift_remove(&probe_path);
            }
            commands
        }
        .boxed_local()
        .shared();
        self.0
            .in_flight
            .borrow_mut()
            .insert(project_path, probe.clone());
        let driver = probe.clone();
        tokio::task::spawn_local(async move {
            driver.await;
        });
        Ok(probe.await)
    }

    pub fn clear(&self) {
        self.0.cache.borrow_mut().clear();
        self.0.in_flight.borrow_mut().clear();
    }
}

async fn probe_claude_slash_commands(
    project_path: &str,
    binary: OsString,
    env_overrides: IndexMap<OsString, OsString>,
    logger: Rc<dyn AgentLogger>,
    request_id: String,
) -> Vec<SlashCommand> {
    let mut environment: IndexMap<_, _> = std::env::vars_os()
        .filter(|(key, _)| key != "CLAUDECODE")
        .collect();
    environment.extend(env_overrides);
    let arguments = [
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    let process = match spawn_claude_subprocess(ClaudeProcessOptions {
        executable: binary,
        arguments,
        cwd: project_path.into(),
        environment,
    }) {
        Ok(process) => process,
        Err(error) => {
            log_probe_error(
                logger.as_ref(),
                "Claude slash-command probe spawn failed",
                project_path,
                error.to_string(),
            );
            return Vec::new();
        }
    };

    let (sender, response) = oneshot::channel();
    let sender = Rc::new(RefCell::new(Some(sender)));
    let finish = Rc::new(move |result: Result<Vec<SlashCommand>, String>| {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    });
    let response_id = request_id.clone();
    let transport = ClaudeProcessTransport::new(ClaudeProcessTransportOptions {
        process,
        logger: logger.clone(),
        session_id: "command-probe".to_owned(),
        on_message: Rc::new({
            let finish = finish.clone();
            move |message| {
                let response = &message["response"];
                if message["type"] != "control_response"
                    || response["request_id"].as_str() != Some(&response_id)
                {
                    return;
                }
                if response["subtype"] == "error" {
                    finish(Err(response["error"]
                        .as_str()
                        .filter(|error| !error.is_empty())
                        .unwrap_or("initialize request failed")
                        .to_owned()));
                } else {
                    let info = &response["response"];
                    finish(Ok(parse_init_slash_commands(
                        &info["commands"],
                        &info["skills"],
                    )));
                }
            }
        }),
        on_failure: Rc::new({
            let finish = finish.clone();
            move |failure| {
                let kind = match failure.kind {
                    crate::cli_process_transport::ClaudeTransportFailureKind::Stdout => "stdout",
                    crate::cli_process_transport::ClaudeTransportFailureKind::Stderr => "stderr",
                    crate::cli_process_transport::ClaudeTransportFailureKind::Write => "write",
                };
                finish(Err(format!("{kind}: {}", failure.message)));
            }
        }),
        on_eof: Rc::new({
            let finish = finish.clone();
            move || finish(Err("stdout ended before initialize completed".to_owned()))
        }),
        on_exit: Rc::new({
            let finish = finish.clone();
            move |exit| finish(Err(format!("process exited with code {}", exit.exit_code)))
        }),
        max_stdout_frame_bytes: None,
    });
    let request = json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "initialize" } });
    let write = transport.write_line(request.to_string(), Default::default());
    tokio::task::spawn_local(async move {
        if let Err(error) = write.await {
            finish(Err(error.to_string()));
        }
    });
    let commands = match tokio::time::timeout(PROBE_TIMEOUT, response).await {
        Ok(Ok(Ok(commands))) => commands,
        Ok(Ok(Err(error))) => {
            log_probe_error(
                logger.as_ref(),
                "Claude slash-command probe failed",
                project_path,
                error,
            );
            Vec::new()
        }
        Ok(Err(error)) => {
            log_probe_error(
                logger.as_ref(),
                "Claude slash-command probe rejected",
                project_path,
                error.to_string(),
            );
            Vec::new()
        }
        Err(_) => {
            log_probe_error(
                logger.as_ref(),
                "Claude slash-command probe failed",
                project_path,
                "initialize request timed out".to_owned(),
            );
            Vec::new()
        }
    };
    if let Err(error) = transport.retire().await {
        log_probe_error(
            logger.as_ref(),
            "Claude slash-command probe teardown failed",
            project_path,
            error,
        );
    }
    commands
}

fn log_probe_error(logger: &dyn AgentLogger, warning: &str, project_path: &str, error: String) {
    let fields = IndexMap::from([
        (
            "projectPath".to_owned(),
            Opaque::from_value(json!(project_path)),
        ),
        ("error".to_owned(), Opaque::from_value(json!(error))),
    ]);
    logger.warn(warning, Some(&fields));
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use garcon_js::ManualClock;
    use tokio::{fs, task::LocalSet};

    use super::*;

    struct Logger;
    impl AgentLogger for Logger {
        fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
        fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    }

    #[tokio::test]
    async fn rejects_lazy_probe_configuration_errors_before_spawning_in_read_order() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let discovery = ClaudeSlashCommandDiscovery::new(
            Rc::new({
                let calls = calls.clone();
                move || {
                    calls.borrow_mut().push("binary");
                    Err("synthetic binary read error".into())
                }
            }),
            Rc::new({
                let calls = calls.clone();
                move || {
                    calls.borrow_mut().push("environment");
                    Err("synthetic environment read error".into())
                }
            }),
            Rc::new(Logger),
        );
        assert!(calls.borrow().is_empty());
        for _ in 0..2 {
            let error = discovery.discover("synthetic-project").await.unwrap_err();
            assert_eq!(error.to_string(), "synthetic binary read error");
        }
        assert_eq!(*calls.borrow(), ["binary", "binary"]);
    }

    #[tokio::test]
    async fn discovers_metadata_over_a_real_initialize_pipe_without_sending_a_prompt() {
        LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let cli = root.path().join("fake-claude");
            fs::write(&cli, r#"#!/usr/bin/env bun
                const { appendFileSync } = require('node:fs');
                const { createInterface } = require('node:readline');
                const input = createInterface({ input: process.stdin });
                input.on('line', (line) => {
                    const frame = JSON.parse(line);
                    appendFileSync('calls.jsonl', JSON.stringify({ frame, args: process.argv.slice(2), endpoint: process.env.ANTHROPIC_BASE_URL, nested: process.env.CLAUDECODE ?? null }) + '\n');
                    process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: 'wrong', subtype: 'success', response: { commands: ['foreign'] } } }) + '\n');
                    process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: { commands: ['clear', 'compact', { name: 'review', type: 'skill', description: 'Read the fixture' }], skills: ['review'] } } }) + '\n');
                });
            "#).await.unwrap();
            fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).await.unwrap();
            let clock = Rc::new(ManualClock::new(10));
            let discovery = ClaudeSlashCommandDiscovery::with_clock_and_ids(
                Rc::new(move || Ok(cli.clone().into_os_string())),
                Rc::new(|| Ok(IndexMap::from([(OsString::from("ANTHROPIC_BASE_URL"), OsString::from("https://synthetic.invalid"))]))),
                Rc::new(Logger), clock.clone(), Rc::new(|| "synthetic-request".to_owned()),
            );
            let project = root.path().to_str().unwrap();
            let (left, right) = tokio::join!(discovery.discover(project), discovery.discover(project));
            let (left, right) = (left.unwrap(), right.unwrap());
            assert_eq!(left, right);
            assert_eq!(left.iter().map(|command| command.name.as_str()).collect::<Vec<_>>(), ["compact", "review"]);
            assert_eq!(left[1].source, SlashCommandSource::Skill);
            assert_eq!(left[1].description.as_deref(), Some("Read the fixture"));
            let calls = root.path().join("calls.jsonl");
            let first = fs::read_to_string(&calls).await.unwrap();
            let mut first_lines = first.lines();
            let observed: Value = garcon_js::json::from_str(first_lines.next().unwrap()).unwrap();
            assert!(first_lines.next().is_none());
            assert_eq!(observed["frame"], json!({ "type": "control_request", "request_id": "synthetic-request", "request": { "subtype": "initialize" } }));
            assert_eq!(observed["endpoint"], "https://synthetic.invalid");
            assert!(observed["nested"].is_null());
            assert_eq!(observed["args"], json!(["--print", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--no-session-persistence"]));
            assert_eq!(discovery.discover(project).await.unwrap(), left);
            assert_eq!(fs::read_to_string(&calls).await.unwrap().lines().count(), 1);
            clock.advance(CACHE_TTL_MS);
            assert_eq!(discovery.discover(project).await.unwrap(), left);
            assert_eq!(fs::read_to_string(&calls).await.unwrap().lines().count(), 2);
        }).await;
    }
}
