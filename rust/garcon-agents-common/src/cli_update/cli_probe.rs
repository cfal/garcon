use std::{ffi::OsStr, path::Path, time::Duration};

use crate::which::which_in;

use super::{
    bounded_command::{BoundedCommandOptions, run_bounded_command},
    cli_version::parse_cli_version,
    installer_environment::Environment,
};

const VERSION_PROBE_MAX_BYTES: usize = 16 * 1024;

pub fn find_executable(command: &str, env: &Environment) -> Option<String> {
    let path = env.get("PATH").or_else(|| env.get("Path")).map(OsStr::new);
    let cwd = std::env::current_dir().unwrap_or_default();
    which_in(OsStr::new(command), path, &cwd)?
        .into_os_string()
        .into_string()
        .ok()
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
