//! Ports the Git error boundary in `server/runtime/git/service-errors.ts`.

use std::error::Error;
use std::sync::LazyLock;

use garcon_base::errors::{ErrorInput, has_node_error_code};
use garcon_base::path_boundary::is_project_boundary_error;
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode, is_git_service_error_code};
use garcon_interface::errors::AgentCallError;
use garcon_js::utf16;
use regress::Regex;
use serde_json::Value;

use super::git_domain_error::GitDomainError;
use super::git_error_classifier::classify_git_error;
use super::operation_context::is_git_cancellation;
use super::run::GitOutputLimitError;

const GIT_ERROR_MESSAGE_LIMIT: usize = 2048;

static MISSING_GIT: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the literal is the original's missing-executable pattern.
    Regex::with_flags("Executable not found.*git|command not found.*git", "i")
        .expect("valid missing Git pattern")
});
static NON_WHITESPACE: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the literal is the original's word-matching pattern.
    Regex::new(r"\S+").expect("valid Git redaction pattern")
});

fn bounded_service_error(code: &str, message: &str) -> GitServiceError {
    let candidate = match code {
        "GIT_LOCKED" | "GH_MISSING" => code.to_owned(),
        _ => format!("GIT_{code}"),
    };
    let service_code = is_git_service_error_code(&Value::String(candidate))
        .unwrap_or(GitServiceErrorCode::GIT_OPERATION_FAILED);
    let redacted;
    let message = if message.contains("://") {
        let mut text = String::new();
        let mut start = 0;
        for word in NON_WHITESPACE.find_iter(message) {
            let range = word.range();
            if message[range.clone()].contains("://") {
                text.push_str(&message[start..range.start]);
                text.push_str("<remote>");
                start = range.end;
            }
        }
        text.push_str(&message[start..]);
        redacted = text;
        &redacted
    } else {
        message
    };
    let mut message_prefix = utf16::truncate(message, GIT_ERROR_MESSAGE_LIMIT).to_owned();
    if utf16::char_code_at(message, GIT_ERROR_MESSAGE_LIMIT)
        .is_some_and(|unit| (0xDC00..=0xDFFF).contains(&unit))
    {
        message_prefix.push(char::REPLACEMENT_CHARACTER);
    }
    GitServiceError::new(service_code, message_prefix)
}

pub fn git_service_error(error: Box<dyn Error>) -> Box<dyn Error> {
    use GitServiceErrorCode as Code;

    if error.is::<GitServiceError>() || error.is::<AgentCallError>() {
        return error;
    }
    if let Some(error) = error.downcast_ref::<GitDomainError>() {
        return bounded_service_error(&error.code, &error.message).into();
    }
    if MISSING_GIT.find(&error.to_string()).is_some() {
        return GitServiceError::new(Code::GIT_MISSING, "Git is not installed on this executor")
            .into();
    }
    let input = ErrorInput::Error(error.as_ref());
    if has_node_error_code(input, "ENOENT") || has_node_error_code(input, "ENOTDIR") {
        return GitServiceError::new(Code::GIT_INVALID_INPUT, "Git path is unavailable").into();
    }
    if is_project_boundary_error(error.as_ref()) {
        return GitServiceError::new(Code::GIT_OUTSIDE_BASE, error.to_string()).into();
    }
    if error.is::<GitOutputLimitError>() {
        return GitServiceError::new(
            Code::GIT_RESULT_TOO_LARGE,
            "Git result exceeds the operation limit",
        )
        .into();
    }
    if is_git_cancellation(error.as_ref()) {
        return GitServiceError::new(Code::GIT_TIMEOUT, "Git operation expired or was cancelled")
            .into();
    }
    let classified = classify_git_error(input);
    bounded_service_error(classified.code, &classified.message).into()
}

#[cfg(test)]
mod tests {
    use garcon_contract::git::StashRefOptions;
    use garcon_interface::resources::ExecutorResult;
    use tokio::task::LocalSet;

    use super::*;
    use crate::git::git_fixture::GitFixture;
    use crate::git::run::{read_only_git_options, run_git};
    use crate::git::stashes::drop_stash;
    use crate::git::types::GitCommandOptions;

    fn mapped(error: Box<dyn Error>) -> GitServiceError {
        *git_service_error(error)
            .downcast::<GitServiceError>()
            .unwrap()
    }

    #[tokio::test]
    async fn maps_domain_and_output_limit_errors_erased_into_executor_results() {
        LocalSet::new().run_until(async {
            let fixture = GitFixture::with_commit().await;
            let project = fixture.path().to_str().unwrap();
            let stash = StashRefOptions {
                project_path: project.into(),
                stash_ref: "stash@{0}".into(),
                expected_hash: "a".repeat(40),
            };
            let result: ExecutorResult<_> = drop_stash(&stash, None).await;
            let error = result.unwrap_err();
            assert!(error.is::<GitDomainError>());
            assert_eq!(mapped(error), GitServiceError::new(
                GitServiceErrorCode::GIT_STALE_STASH,
                "The stash list changed since it was loaded. Select the stash again from the current list.",
            ));

            let result: ExecutorResult<_> = run_git(
                project,
                ["rev-parse", "--show-toplevel"].map(str::to_owned).into(),
                read_only_git_options(GitCommandOptions {
                    max_stdout_bytes: Some(1),
                    ..Default::default()
                }),
            ).await;
            let error = result.unwrap_err();
            assert!(error.is::<GitOutputLimitError>());
            assert_eq!(mapped(error), GitServiceError::new(
                GitServiceErrorCode::GIT_RESULT_TOO_LARGE,
                "Git result exceeds the operation limit",
            ));
        }).await;
    }

    #[tokio::test]
    async fn unavailable_path_uses_the_real_io_error_code() {
        let fixture = GitFixture::empty();
        let error = tokio::fs::read(fixture.path().join("absent"))
            .await
            .unwrap_err();
        assert_eq!(
            mapped(error.into()),
            GitServiceError::new(
                GitServiceErrorCode::GIT_INVALID_INPUT,
                "Git path is unavailable",
            )
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn distinguishes_missing_git_on_the_child_path_from_a_missing_working_directory() {
        use std::io;
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;
        use std::process::Stdio;

        use garcon_base::errors::{NamedError, diagnostic_error_code};
        use serde_json::json;
        use tokio::io::AsyncWriteExt;
        use tokio::process::Command;

        LocalSet::new()
            .run_until(async {
                let fixture = GitFixture::with_commit().await;
                let cwd = fixture.path().to_str().unwrap();
                let absent = fixture.path().join("absent");
                let absent = absent.to_str().unwrap();
                let bin = fixture.path().join("bin");
                tokio::fs::create_dir(&bin).await.unwrap();
                let git = bin.join("git");
                tokio::fs::write(&git, "#!/nonexistent\n").await.unwrap();
                tokio::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o700))
                    .await
                    .unwrap();

                let cases = [
                    (cwd, Some(absent), false, true),
                    (absent, None, false, false),
                    (cwd, Some("bin"), false, false),
                    (cwd, Some(absent), true, true),
                    (cwd, Some("bin"), true, false),
                ];
                let mut bun = Command::new("bun")
                    .arg(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("tests/oracles/git-spawn-errors.ts"),
                    )
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap();
                let requests: Vec<_> = cases
                    .iter()
                    .map(|(cwd, path, _, _)| json!({ "cwd": cwd, "path": path }))
                    .collect();
                bun.stdin
                    .take()
                    .unwrap()
                    .write_all(&serde_json::to_vec(&requests).unwrap())
                    .await
                    .unwrap();
                let output = bun.wait_with_output().await.unwrap();
                assert!(
                    output.status.success(),
                    "original spawn errors: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let original: Vec<Value> = garcon_js::json::from_slice(&output.stdout).unwrap();

                assert_eq!(original.len(), cases.len());
                for ((cwd, path, worker, missing_executable), expected) in
                    cases.into_iter().zip(original)
                {
                    let base_environment = worker.then(|| [("PATH".into(), absent.into())].into());
                    let env = path
                        .filter(|path| !worker || *path != absent)
                        .map(|path| [("PATH".into(), Some(path.into()))].into());
                    let result: ExecutorResult<_> = run_git(
                        cwd,
                        vec!["--version".into()],
                        GitCommandOptions {
                            base_environment,
                            env,
                            ..Default::default()
                        },
                    )
                    .await;
                    let error = result.unwrap_err();
                    assert_eq!(
                        diagnostic_error_code(ErrorInput::Error(error.as_ref())),
                        expected["code"]
                    );
                    if missing_executable {
                        assert!(error.is::<NamedError>());
                        assert_eq!(error.to_string(), expected["message"]);
                    } else {
                        // Bun labels the native spawn error; Rust retains the I/O error itself.
                        assert_eq!(
                            expected["message"],
                            "ENOENT: no such file or directory, posix_spawn 'git'"
                        );
                        assert_eq!(
                            error.downcast_ref::<io::Error>().unwrap().kind(),
                            io::ErrorKind::NotFound
                        );
                    }
                    let error = mapped(error);
                    assert_eq!(error.code.as_str(), expected["serviceCode"]);
                    assert_eq!(error.message, expected["serviceMessage"]);
                }
            })
            .await;
    }

    #[test]
    fn redacting_a_pull_remote_preserves_the_later_failure_reason() {
        let error = mapped("git pull failed (exit 128): From https://user:example@host/project\nfatal: Need to specify how to reconcile divergent branches.".into());
        assert_eq!(error.code, GitServiceErrorCode::GIT_OPERATION_FAILED);
        assert_eq!(
            error.message,
            "git pull failed (exit 128): From <remote>\nfatal: Need to specify how to reconcile divergent branches."
        );
    }

    #[test]
    fn slices_errors_at_the_same_utf16_boundary_as_the_original() {
        let before = "x".repeat(GIT_ERROR_MESSAGE_LIMIT - 1);
        let error = mapped(format!("{before}\u{1f600} after").into());
        assert_eq!(error.message, format!("{before}\u{fffd}"));
    }
}
