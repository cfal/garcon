use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use super::{
    bounded_command::{BoundedCommandOptions, run_bounded_command},
    cli_version::parse_cli_version,
    installer_environment::Environment,
};

const VERSION_PROBE_MAX_BYTES: usize = 16 * 1024;

pub fn find_executable(command: &str, env: &Environment) -> Option<String> {
    if command.is_empty() {
        return None;
    }
    let path = Path::new(command);
    let candidates =
        if path.is_absolute() || command.contains('/') || (cfg!(windows) && command.contains('\\'))
        {
            vec![PathBuf::from(command.strip_prefix("./").unwrap_or(command))]
        } else {
            let path_env = env.get("PATH").or_else(|| env.get("Path"))?;
            std::env::split_paths(path_env)
                .filter(|root| !root.as_os_str().is_empty())
                .map(|root| root.join(path))
                .collect()
        };
    for path in candidates {
        if let Some(path) = executable_candidate(path) {
            let path = if path.is_absolute() {
                path
            } else {
                std::env::current_dir().ok()?.join(path)
            };
            return path.into_os_string().into_string().ok();
        }
    }
    None
}

#[cfg(not(windows))]
fn executable_candidate(path: PathBuf) -> Option<PathBuf> {
    is_executable_file(&path).then_some(path)
}

#[cfg(windows)]
fn executable_candidate(path: PathBuf) -> Option<PathBuf> {
    if is_executable_file(&path) {
        return Some(path);
    }
    if path.extension().is_some() {
        return None;
    }
    ["exe", "cmd", "bat", "com"]
        .into_iter()
        .map(|extension| path.with_extension(extension))
        .find(|path| is_executable_file(path))
}

pub(super) fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: path is a NUL-terminated string that lives for the call.
        (unsafe { libc::access(path.as_ptr(), libc::X_OK) }) == 0
    }
    #[cfg(not(unix))]
    true
}

pub async fn probe_cli_version(
    executable: &str,
    env: &Environment,
    timeout: Duration,
) -> Option<String> {
    let result = run_bounded_command(
        executable,
        &["--version".into()],
        BoundedCommandOptions {
            env,
            timeout,
            max_output_bytes: VERSION_PROBE_MAX_BYTES,
            on_line: None,
        },
    )
    .await
    .ok()?;
    if result.exit_code != Some(0) {
        return None;
    }
    parse_cli_version(&format!("{}\n{}", result.stdout, result.stderr)).map(str::to_owned)
}
