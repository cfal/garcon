//! Ports `server/runtime/git/comparison-errors.ts`.

use std::error::Error;

use garcon_js::trim;

use super::types::GitProcessError;

fn normal_exit(error: &GitProcessError) -> bool {
    error.timed_out != Some(true) && error.aborted != Some(true)
}

pub fn is_expected_missing_git_result(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<GitProcessError>()
        .is_some_and(|error| normal_exit(error) && error.code == Some(1))
}

fn reflog_entry_unavailable(stderr: &str) -> bool {
    let Some((reference, entries)) = trim(stderr)
        .strip_prefix("fatal: log for '")
        .and_then(|message| message.strip_suffix(" entries"))
        .and_then(|message| message.rsplit_once("' only has "))
    else {
        return false;
    };
    !reference.is_empty()
        && !reference.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        && !entries.is_empty()
        && entries.bytes().all(|byte| byte.is_ascii_digit())
}

pub fn is_unresolved_revision(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<GitProcessError>()
        .is_some_and(|error| {
            normal_exit(error)
                && match error.code {
                    Some(1) => true,
                    Some(128) => reflog_entry_unavailable(&error.stderr),
                    _ => false,
                }
        })
}

pub fn needs_revision_failure_diagnostics(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<GitProcessError>()
        .is_some_and(|error| {
            error.code == Some(128)
                && normal_exit(error)
                && trim(&error.stdout).is_empty()
                && trim(&error.stderr).is_empty()
        })
}
