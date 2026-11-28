//! Ports `server-agents/common/src/environment/executable-override.ts`.

use garcon_js::path::{posix, win32};

/// Returns an absolute or bare command as it is, and resolves any other
/// against `cwd`, which stands for `process.cwd()`. A child may run in a
/// project, a temporary directory, or the user's home, so a relative override
/// is made absolute here. `platform` of `None` is this process's platform.
pub fn resolve_executable_override(command: &str, platform: Option<&str>, cwd: &str) -> String {
    if platform.map_or(cfg!(windows), |platform| platform == "win32") {
        if win32::is_absolute(command) || win32::basename(command) == command {
            return command.to_owned();
        }
        win32::resolve(cwd, &[command])
    } else {
        if posix::is_absolute(command) || posix::basename(command) == command {
            return command.to_owned();
        }
        posix::resolve(cwd, &[command])
    }
}
