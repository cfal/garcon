use std::{
    cell::RefCell,
    ffi::{OsStr, OsString},
    process::Stdio,
    rc::Rc,
    sync::LazyLock,
    time::Duration,
};

use futures::future::{FutureExt, LocalBoxFuture, Shared};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, trim};
use indexmap::IndexMap;
use regress::Regex;
use tokio::io::AsyncReadExt;

use crate::cli_process_transport::{
    ClaudeExitStatus, ClaudeProcessOptions, ClaudeProcessSignal, ProcessOutput,
    spawn_claude_subprocess_with_stdin,
};

pub type CliVersion = [Number; 3];
pub const MINIMUM_CLAUDE_CLI_VERSION: CliVersion = [Number(2.0), Number(1.0), Number(238.0)];
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_PROBE_EXIT_GRACE: Duration = Duration::from_secs(1);
const MAX_VERSION_OUTPUT_BYTES: usize = 16 * 1024;

static VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The static expression is valid ECMAScript syntax.
    Regex::new(r"(\d+)\.(\d+)\.(\d+)").expect("Claude CLI version expression")
});

pub fn parse_claude_cli_version(output: &str) -> Option<CliVersion> {
    let version = VERSION_PATTERN.find(output)?;
    let component = |group| {
        output[version.group(group)?]
            .parse::<f64>()
            .ok()
            .map(Number)
    };
    Some([component(1)?, component(2)?, component(3)?])
}

pub fn is_version_before(version: CliVersion, threshold: CliVersion) -> bool {
    for (actual, minimum) in version.into_iter().zip(threshold) {
        if actual != minimum {
            return actual.0 < minimum.0;
        }
    }
    false
}

fn version_text(version: CliVersion) -> String {
    format!(
        "{}.{}.{}",
        version[0].to_js_string(),
        version[1].to_js_string(),
        version[2].to_js_string()
    )
}

async fn wait_for_version_exit(
    status: ClaudeExitStatus,
    timeout: Duration,
) -> Result<Option<i32>, String> {
    tokio::select! {
        biased;
        status = status => status.map(Some),
        () = tokio::time::sleep(timeout) => Ok(None),
    }
}

async fn read_probe_output(stream: Option<ProcessOutput>) -> Result<String, String> {
    let Some(mut stream) = stream else {
        return Ok(String::new());
    };
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if output.len() + read > MAX_VERSION_OUTPUT_BYTES {
            return Err("Claude CLI version output exceeded its size limit".to_owned());
        }
        output.extend_from_slice(&buffer[..read]);
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

async fn probe_claude_cli_version(binary: OsString) -> Result<CliVersion, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let process = spawn_claude_subprocess_with_stdin(
        ClaudeProcessOptions {
            executable: binary,
            arguments: vec!["--version".into()],
            cwd,
            environment: std::env::vars_os().collect(),
        },
        Stdio::null(),
    )
    .map_err(|error| error.to_string())?;
    let stdout = tokio::task::spawn_local(read_probe_output(process.stdout));
    let stderr = tokio::task::spawn_local(read_probe_output(process.stderr));
    let exited = process.exited.shared();
    let mut exit_code = wait_for_version_exit(exited.clone(), VERSION_PROBE_TIMEOUT).await?;
    if exit_code.is_none() {
        (process.kill)(ClaudeProcessSignal::Term).map_err(|error| error.to_string())?;
        exit_code = wait_for_version_exit(exited.clone(), VERSION_PROBE_EXIT_GRACE).await?;
    }
    if exit_code.is_none() {
        (process.kill)(ClaudeProcessSignal::Kill).map_err(|error| error.to_string())?;
        exit_code = wait_for_version_exit(exited, VERSION_PROBE_EXIT_GRACE).await?;
    }
    let exit_code = exit_code
        .ok_or_else(|| "Claude CLI version probe did not exit after SIGKILL".to_owned())?;
    let (output, error_output) = tokio::try_join!(
        async { stdout.await.map_err(|error| error.to_string())? },
        async { stderr.await.map_err(|error| error.to_string())? },
    )?;
    if exit_code != 0 {
        let detail = trim(&error_output);
        return Err(if detail.is_empty() {
            format!("Claude CLI version probe exited with code {exit_code}")
        } else {
            format!("Claude CLI version probe exited with code {exit_code}: {detail}")
        });
    }
    parse_claude_cli_version(&output)
        .ok_or_else(|| "Could not parse the installed Claude CLI version".to_owned())
}

type VersionFuture = Shared<LocalBoxFuture<'static, Result<CliVersion, String>>>;

struct VersionEntry {
    token: Rc<()>,
    status: VersionFuture,
}
type VersionCache = Rc<RefCell<IndexMap<OsString, VersionEntry>>>;

#[derive(Default)]
pub struct ClaudeCliVersionProbe {
    versions: VersionCache,
}

impl ClaudeCliVersionProbe {
    pub async fn assert_compatible(&self, binary: &OsStr) -> ExecutorResult<CliVersion> {
        let version = self.version(binary).await?;
        if is_version_before(version, MINIMUM_CLAUDE_CLI_VERSION) {
            return Err(format!(
                "Claude Code {} is unsupported. Upgrade to {} or newer.",
                version_text(version),
                version_text(MINIMUM_CLAUDE_CLI_VERSION)
            )
            .into());
        }
        Ok(version)
    }

    pub fn invalidate(&self) {
        self.versions.borrow_mut().clear();
    }

    fn version(&self, binary: &OsStr) -> VersionFuture {
        if let Some(cached) = self.versions.borrow().get(binary) {
            return cached.status.clone();
        }
        let binary = binary.to_owned();
        let token = Rc::new(());
        let probe_token = token.clone();
        let probe_binary = binary.clone();
        let cache = Rc::downgrade(&self.versions);
        let version = async move {
            let result = probe_claude_cli_version(probe_binary.clone()).await;
            if result.is_err()
                && let Some(cache) = cache.upgrade()
            {
                let mut cache = cache.borrow_mut();
                if cache
                    .get(&probe_binary)
                    .is_some_and(|current| Rc::ptr_eq(&current.token, &probe_token))
                {
                    cache.shift_remove(&probe_binary);
                }
            }
            result
        }
        .boxed_local()
        .shared();
        self.versions.borrow_mut().insert(
            binary,
            VersionEntry {
                token,
                status: version.clone(),
            },
        );
        let task = version.clone();
        tokio::task::spawn_local(async move {
            let _ = task.await;
        });
        version
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text, unknown};
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn recorded_version_helpers_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-version"),
            |function, args| match function {
                "parseClaudeCliVersion" => {
                    let output = text(function, args.first())?.expect("recorded version output");
                    Ok(garcon_js::json::from_slice(
                        &serde_json::to_vec(&parse_claude_cli_version(output)).unwrap(),
                    )
                    .unwrap())
                }
                "isVersionBefore" => {
                    let version = unknown(function, args.first())?;
                    let threshold = unknown(function, args.get(1))?;
                    let components = |value: &Value| {
                        [0, 1, 2].map(|index| Number(value[index].as_f64().unwrap()))
                    };
                    Ok(json!(is_version_before(
                        components(&version),
                        components(&threshold)
                    )))
                }
                _ => Err(CaseError::unhandled(function)),
            },
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn caches_available_versions_retries_failed_probes_and_invalidates_in_place_updates() {
        use std::os::unix::fs::PermissionsExt;
        use tokio::{fs, task::LocalSet};

        LocalSet::new().run_until(async {
            let directory = tempfile::tempdir().unwrap();
            let binary = directory.path().join("fake-claude");
            let log = directory.path().join("calls");
            let version = directory.path().join("version");
            let write_binary = format!("#!/bin/sh\nprintf 'probe\\n' >> '{}'\nif [ ! -f '{}' ]; then printf 'transient failure\\n' >&2; exit 1; fi\ncat '{}'\n", log.display(), version.display(), version.display());
            fs::write(&binary, write_binary.as_bytes()).await.unwrap();
            fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).await.unwrap();
            let probe = ClaudeCliVersionProbe::default();
            assert_eq!(probe.assert_compatible(binary.as_os_str()).await.unwrap_err().to_string(), "Claude CLI version probe exited with code 1: transient failure");
            fs::write(&version, b"2.1.238 (Claude Code)").await.unwrap();
            let left = probe.assert_compatible(binary.as_os_str());
            let right = probe.assert_compatible(binary.as_os_str());
            let (left, right) = tokio::try_join!(left, right).unwrap();
            assert_eq!(left, MINIMUM_CLAUDE_CLI_VERSION);
            assert_eq!(left, right);
            assert_eq!(fs::read(&log).await.unwrap(), b"probe\nprobe\n");
            fs::write(&version, b"2.1.237 (Claude Code)").await.unwrap();
            assert_eq!(probe.assert_compatible(binary.as_os_str()).await.unwrap(), MINIMUM_CLAUDE_CLI_VERSION);
            probe.invalidate();
            assert_eq!(probe.assert_compatible(binary.as_os_str()).await.unwrap_err().to_string(), "Claude Code 2.1.237 is unsupported. Upgrade to 2.1.238 or newer.");
            assert_eq!(fs::read(&log).await.unwrap(), b"probe\nprobe\nprobe\n");
        }).await;
    }
}
