//! Ports `server-agents/opencode/src/agents/opencode/server-instance.ts`.

use std::{
    cell::{Cell, RefCell},
    error::Error,
    ffi::OsStr,
    io,
    process::{ExitStatus, Stdio},
    rc::Rc,
    time::Duration,
};

use futures::{FutureExt, future::pending};
use garcon_base::errors::{ErrorInput, NamedError, diagnostic_error_code};
use garcon_interface::resources::ExecutorResult;
use garcon_js::OptionalNullable;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::oneshot,
    task::spawn_local,
};

use super::instance_lifecycle::{OpenCodeInstance, OpenCodeServer, OpenCodeServerTermination};
use super::jsonc::{self, ParseOptions};
use super::sdk_client::OpenCodeSdkClient;
use super::session_identity_plugin::resolve_session_identity_plugin_url;
use crate::js::{AbortSignal, error, is_js_whitespace, shared_error};

// The environment a child receives: every variable of the parent. A variable
// the parent lists without a value is absent there, and one it lists as
// `null` is kept apart from it, because the original writes the two apart.
pub type ServerEnvironment = IndexMap<String, OptionalNullable<String>>;

/// `process.env` for a spawn: each variable in the order the parent lists them.
pub fn process_environment() -> ServerEnvironment {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                OptionalNullable::some(value.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

fn plugin_specifier(entry: &Value) -> Option<&str> {
    if let Some(specifier) = entry.as_str() {
        return Some(specifier);
    }
    let entry = entry.as_array()?;
    if entry.len() != 2 {
        return None;
    }
    let specifier = entry[0].as_str()?;
    // `entry[1] !== null && typeof entry[1] === 'object' && !Array.isArray(entry[1])`
    let options = &entry[1];
    if !options.is_object() {
        return None;
    }
    Some(specifier)
}

pub fn merge_open_code_config_content(
    inherited_content: Option<&str>,
    session_identity_plugin_url: &str,
) -> Result<String, Box<dyn Error>> {
    let invalid = |detail: &str| {
        error(
            "Error",
            format!("Invalid inherited OPENCODE_CONFIG_CONTENT{detail}"),
        )
    };
    let mut inherited = Value::Object(Map::new());
    if let Some(content) = inherited_content.filter(|content| !garcon_js::trim(content).is_empty())
    {
        let (parsed, errors) = jsonc::parse(
            content,
            ParseOptions {
                disallow_comments: false,
                allow_trailing_comma: true,
                allow_empty_content: false,
            },
        );
        if let Some(first) = errors.first() {
            return Err(error(
                "Error",
                format!(
                    "Invalid inherited OPENCODE_CONFIG_CONTENT at offset {}: {}.",
                    first.offset,
                    first.code.name()
                ),
            ));
        }
        inherited = parsed.unwrap_or(Value::Null);
    }
    let mut config = match inherited {
        Value::Object(config) => config,
        _ => return Err(invalid(": expected a JSONC object.")),
    };

    if config
        .get("plugin")
        .is_some_and(|plugin| !plugin.is_array())
    {
        return Err(invalid(": \"plugin\" must be an array."));
    }
    let plugins: &[Value] = config
        .get("plugin")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    if let Some(invalid_plugin_index) = plugins
        .iter()
        .position(|entry| plugin_specifier(entry).is_none())
    {
        return Err(error(
            "Error",
            format!(
                "Invalid inherited OPENCODE_CONFIG_CONTENT: \"plugin[{invalid_plugin_index}]\" must be a string or [specifier, options] tuple."
            ),
        ));
    }
    // The last entry that already names the plugin is kept as it is, options included.
    let session_identity_plugin_entry = plugins
        .iter()
        .rev()
        .find(|entry| plugin_specifier(entry) == Some(session_identity_plugin_url))
        .cloned()
        .unwrap_or_else(|| Value::String(session_identity_plugin_url.to_owned()));
    let mut plugins_kept: Vec<Value> = plugins
        .iter()
        .filter(|entry| plugin_specifier(entry) != Some(session_identity_plugin_url))
        .cloned()
        .collect();
    plugins_kept.push(session_identity_plugin_entry);
    // A `plugin` already in the configuration keeps its place, as spreading does.
    config.insert("plugin".to_owned(), Value::Array(plugins_kept));
    Ok(garcon_js::json::stringify(&Value::Object(config)))
}

/// The environment `opencode serve` runs with: the base environment without
/// the ambient session identity and pure mode, its inline configuration
/// carrying the Garcon plugin, and provider-managed updates off.
pub fn build_open_code_server_env(
    base_env: Option<&ServerEnvironment>,
    session_identity_plugin_url: Option<&str>,
    platform: Option<&str>,
) -> Result<ServerEnvironment, Box<dyn Error>> {
    let process_env;
    let base_env = match base_env {
        Some(base_env) => base_env,
        None => {
            process_env = process_environment();
            &process_env
        }
    };
    let plugin_url;
    let session_identity_plugin_url = match session_identity_plugin_url {
        Some(url) => url,
        None => {
            plugin_url = resolve_session_identity_plugin_url()?;
            plugin_url.as_str()
        }
    };
    let platform = platform.unwrap_or(process_platform());
    let mut server_env = base_env.clone();
    let mut inherited_config_content = server_env
        .get("OPENCODE_CONFIG_CONTENT")
        .and_then(|value| value.as_deref())
        .map(str::to_owned);
    for key in base_env.keys() {
        let normalized_key = if platform == "win32" {
            key.to_uppercase()
        } else {
            key.clone()
        };
        if normalized_key == "OPENCODE_CONFIG_CONTENT" {
            // The first variable of that name that has a value is the inherited one.
            if inherited_config_content.is_none() {
                inherited_config_content = server_env
                    .shift_remove(key)
                    .and_then(|value| value.as_deref().map(str::to_owned));
            } else {
                server_env.shift_remove(key);
            }
        } else if normalized_key == "OPENCODE_PURE" || normalized_key == "OPENCODE_SESSION_ID" {
            server_env.shift_remove(key);
        }
    }
    server_env.insert(
        "OPENCODE_CONFIG_CONTENT".to_owned(),
        OptionalNullable::some(merge_open_code_config_content(
            inherited_config_content.as_deref(),
            session_identity_plugin_url,
        )?),
    );
    server_env.insert(
        "OPENCODE_DISABLE_AUTOUPDATE".to_owned(),
        OptionalNullable::some("1".to_owned()),
    );
    Ok(server_env)
}

// `process.platform`, in the names Node gives it.
fn process_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

pub async fn create_open_code_instance(
    signal: AbortSignal,
) -> ExecutorResult<Rc<OpenCodeInstance>> {
    create_open_code_instance_at(OsStr::new("opencode"), signal).await
}

async fn create_open_code_instance_at(
    executable: &OsStr,
    signal: AbortSignal,
) -> ExecutorResult<Rc<OpenCodeInstance>> {
    signal.throw_if_aborted()?;
    let environment = build_open_code_server_env(None, None, None)?;
    let mut child = Command::new(executable)
        .args(["serve", "--hostname=127.0.0.1", "--port=0"])
        .env_clear()
        .envs(
            environment
                .iter()
                .filter_map(|(key, value)| value.as_deref().map(|value| (key, value))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|failure| spawn_error(executable, failure))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let url = match wait_for_startup(&mut child, &mut stdout, &mut stderr, &signal).await {
        Ok(url) => url,
        Err(failure) => {
            let stopping = request_process_stop(&mut child);
            drop(stdout);
            drop(stderr);
            if matches!(stopping, Ok(None)) {
                spawn_local(async move {
                    let _ = wait_after_process_stop(&mut child).await;
                });
            }
            return Err(failure);
        }
    };

    let (close, closing) = oneshot::channel();
    let close = RefCell::new(Some(close));
    let (terminated, termination) = oneshot::channel();
    let exit_observed = Rc::new(Cell::new(false));
    spawn_local({
        let exit_observed = exit_observed.clone();
        async move {
            let outcome = observe_process(child, stdout, stderr, closing).await;
            exit_observed.set(true);
            let _ = terminated.send(outcome);
        }
    });
    let termination = async move {
        termination.await.unwrap_or_else(|_| {
            OpenCodeServerTermination::Error(shared_error(
                "Error",
                "OpenCode server lifetime ended without a termination result",
            ))
        })
    }
    .boxed_local()
    .shared();
    Ok(Rc::new(OpenCodeInstance {
        client: Rc::new(OpenCodeSdkClient::new(&url)),
        base_url: Some(url),
        server: Some(OpenCodeServer {
            close: Some(Rc::new(move || {
                if let Some(close) = close.take() {
                    let _ = close.send(());
                }
                Ok(())
            })),
            termination: Some(termination),
            exit_observed: Some(Rc::new(move || exit_observed.get())),
        }),
        close: None,
    }))
}

fn spawn_error(executable: &OsStr, failure: io::Error) -> Box<dyn Error> {
    let code = diagnostic_error_code(ErrorInput::Error(&failure));
    NamedError {
        name: "Error".to_owned(),
        message: format!("spawn {} {code}", executable.to_string_lossy()),
        code: Some(code.to_owned()),
    }
    .into()
}

async fn wait_for_startup<Out: AsyncRead + Unpin, Err: AsyncRead + Unpin>(
    child: &mut Child,
    stdout: &mut Option<Out>,
    stderr: &mut Option<Err>,
    signal: &AbortSignal,
) -> ExecutorResult<String> {
    let mut output = String::new();
    let mut stdout_bytes = [0; 8192];
    let mut stderr_bytes = [0; 8192];
    loop {
        tokio::select! {
            biased;
            () = signal.token().cancelled() => return Err(signal.abort_reason().into()),
            size = read_open_pipe(stdout, &mut stdout_bytes) => {
                let size = size?;
                if size > 0 {
                    output.push_str(&String::from_utf8_lossy(&stdout_bytes[..size]));
                    if let Some(url) = startup_url(&output)? {
                        return Ok(url);
                    }
                }
            }
            size = read_open_pipe(stderr, &mut stderr_bytes) => {
                output.push_str(&String::from_utf8_lossy(&stderr_bytes[..size?]));
            }
            exit = child.wait() => {
                let exit = exit?;
                let code = exit.code().map(|code| code.to_string()).or_else(|| exit_signal(exit)).unwrap_or_else(|| "null".to_owned());
                let output = garcon_js::trim(&output);
                let detail = if output.is_empty() { String::new() } else { format!("\nServer output: {output}") };
                return Err(error("Error", format!("OpenCode server exited before startup with code {code}{detail}")));
            }
        }
    }
}

fn startup_url(output: &str) -> ExecutorResult<Option<String>> {
    for line in output.split('\n') {
        if !line.starts_with("opencode server listening") {
            continue;
        }
        for (index, _) in line.match_indices("on") {
            let tail = &line[index + 2..];
            let candidate = garcon_js::trim_start(tail);
            if tail.len() == candidate.len() {
                continue;
            }
            let url = candidate.split(is_js_whitespace).next().unwrap_or_default();
            if url
                .strip_prefix("http://")
                .or_else(|| url.strip_prefix("https://"))
                .is_some_and(|tail| !tail.is_empty())
            {
                return Ok(Some(url.to_owned()));
            }
        }
        return Err(error(
            "Error",
            format!("Failed to parse OpenCode server URL from output: {line}"),
        ));
    }
    Ok(None)
}

async fn read_open_pipe<T: AsyncRead + Unpin>(
    pipe: &mut Option<T>,
    buffer: &mut [u8],
) -> io::Result<usize> {
    let Some(reader) = pipe.as_mut() else {
        return pending().await;
    };
    let read = reader.read(buffer).await;
    if !matches!(read, Ok(size) if size > 0) {
        *pipe = None;
    }
    read
}

async fn observe_process<Out: AsyncRead + Unpin, Err: AsyncRead + Unpin>(
    mut child: Child,
    mut stdout: Option<Out>,
    mut stderr: Option<Err>,
    mut close: oneshot::Receiver<()>,
) -> OpenCodeServerTermination {
    let mut stdout_bytes = [0; 8192];
    let mut stderr_bytes = [0; 8192];
    let outcome = loop {
        tokio::select! {
            biased;
            result = child.wait() => break result,
            _ = &mut close => {
                let stopping = request_process_stop(&mut child);
                drop(stdout);
                drop(stderr);
                break match stopping {
                    Ok(Some(exit)) => Ok(exit),
                    Ok(None) => wait_after_process_stop(&mut child).await,
                    Err(failure) => Err(failure),
                };
            }
            _ = read_open_pipe(&mut stdout, &mut stdout_bytes) => {},
            _ = read_open_pipe(&mut stderr, &mut stderr_bytes) => {},
        }
    };
    match outcome {
        Ok(exit) => OpenCodeServerTermination::Exit {
            code: exit.code(),
            signal: exit_signal(exit),
        },
        Err(failure) => OpenCodeServerTermination::Error(crate::js::SharedError::new(failure)),
    }
}

fn request_process_stop(child: &mut Child) -> io::Result<Option<ExitStatus>> {
    if let Some(exit) = child.try_wait()? {
        return Ok(Some(exit));
    }
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
    #[cfg(not(unix))]
    child.start_kill()?;
    Ok(None)
}

async fn wait_after_process_stop(child: &mut Child) -> io::Result<ExitStatus> {
    tokio::select! {
        biased;
        exit = child.wait() => exit,
        () = tokio::time::sleep(Duration::from_millis(500)) => {
            child.start_kill()?;
            child.wait().await
        }
    }
}

fn exit_signal(exit: ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        exit.signal()
            .and_then(|signal| nix::sys::signal::Signal::try_from(signal).ok())
            .map(|signal| signal.as_str().to_owned())
    }
    #[cfg(not(unix))]
    {
        let _ = exit;
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{os::unix::fs::PermissionsExt, path::PathBuf};

    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    use tokio::{task::LocalSet, time::timeout};

    use super::*;
    use crate::agents::opencode::instance_lifecycle::close_open_code_instance;

    const START: &str = "\
[ \"$*\" = 'serve --hostname=127.0.0.1 --port=0' ] || exit 78\n\
printf '%s' \"$$\" > \"$0.pid\"\n\
printf 'opencode server listening on http://127.0.0.1:12345\\n'\n\
exec /bin/sleep 60\n";

    fn fake_cli(body: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("fake CLI directory");
        let path = directory.path().join("opencode");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).expect("write fake CLI");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("make fake CLI executable");
        (directory, path)
    }

    #[tokio::test]
    async fn observes_the_real_child_pid_terminating_after_readiness() {
        LocalSet::new().run_until(async {
            let (_directory, path) = fake_cli(START);
            let instance = timeout(Duration::from_secs(5), create_open_code_instance_at(path.as_os_str(), AbortSignal::new())).await
                .expect("ready within fixture deadline").expect("fake CLI ready");
            assert_eq!(instance.base_url.as_deref(), Some("http://127.0.0.1:12345"));
            let server = instance.server.as_ref().expect("process lifetime");
            let exit_observed = server.exit_observed.as_ref().expect("exit observer");
            assert!(!exit_observed());
            let pid = std::fs::read_to_string(path.with_extension("pid")).expect("CLI PID").parse().expect("numeric PID");
            kill(Pid::from_raw(pid), Signal::SIGTERM).expect("signal spawned fixture PID");
            let termination = server.termination.clone().expect("termination promise");
            let outcome = timeout(Duration::from_secs(5), termination.clone()).await.expect("observed exit");
            assert!(matches!(outcome, OpenCodeServerTermination::Exit { code: None, signal: Some(signal) } if signal == "SIGTERM"));
            assert!(exit_observed());
            assert!(matches!(termination.await, OpenCodeServerTermination::Exit { code: None, .. }));
        }).await;
    }

    #[tokio::test]
    async fn reports_early_process_exit_with_startup_output() {
        LocalSet::new().run_until(async {
            let (_directory, path) = fake_cli("printf 'bad configuration\\n' >&2; exit 23\n");
            let result = timeout(Duration::from_secs(5), create_open_code_instance_at(path.as_os_str(), AbortSignal::new())).await.expect("fixture deadline");
            assert_eq!(result.err().expect("startup rejected").to_string(), "OpenCode server exited before startup with code 23\nServer output: bad configuration");
        }).await;
    }

    #[tokio::test]
    async fn closing_the_child_is_idempotent_and_reaps_it() {
        LocalSet::new().run_until(async {
            let (_directory, path) = fake_cli(START);
            let instance = timeout(Duration::from_secs(5), create_open_code_instance_at(path.as_os_str(), AbortSignal::new())).await
                .expect("fixture deadline").expect("fake CLI ready");
            let termination = instance.server.as_ref().and_then(|server| server.termination.clone()).expect("termination promise");
            close_open_code_instance(&instance);
            close_open_code_instance(&instance);
            let outcome = timeout(Duration::from_secs(5), termination).await.expect("observed exit");
            assert!(matches!(outcome, OpenCodeServerTermination::Exit { code: None, signal: Some(signal) } if signal == "SIGTERM"));
        }).await;
    }

    #[tokio::test]
    async fn escalates_after_the_grace_period_when_the_child_ignores_term() {
        LocalSet::new().run_until(async {
            let (_directory, path) = fake_cli(&format!("trap '' TERM\n{START}"));
            let instance = timeout(Duration::from_secs(5), create_open_code_instance_at(path.as_os_str(), AbortSignal::new())).await
                .expect("fixture deadline").expect("fake CLI ready");
            let mut termination = instance.server.as_ref().and_then(|server| server.termination.clone()).expect("termination promise");
            tokio::time::pause();
            close_open_code_instance(&instance);
            tokio::select! {
                biased;
                outcome = &mut termination => panic!("premature process termination: {outcome:?}"),
                () = tokio::time::sleep(Duration::from_millis(499)) => {},
            }
            let outcome = termination.await;
            assert!(matches!(outcome, OpenCodeServerTermination::Exit { code: None, signal: Some(signal) } if signal == "SIGKILL"));
        }).await;
    }
}
