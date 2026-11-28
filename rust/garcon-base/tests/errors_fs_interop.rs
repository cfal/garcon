use std::io;
#[cfg(unix)]
use std::{path::Path, process::Command};

use garcon_base::{
    errors::{
        DiagnosticError, ErrorInput, ErrorMetadata, diagnostic_error_code, has_node_error_code,
    },
    http_body::MalformedJsonError,
    keyed_lock::LockAborted,
    promise_timeout::PromiseTimeoutError,
};
use garcon_contract::{
    chat_id::parse_chat_id,
    git_error::{GitServiceError, GitServiceErrorCode},
    server_runtime::ServerRuntimeContractError,
    terminal::TerminalErrorCode,
    terminal_error::TerminalError,
};
#[cfg(unix)]
use serde::Deserialize;
use serde_json::Value;
#[cfg(unix)]
use tokio::fs;

#[cfg(unix)]
#[derive(Deserialize)]
struct Oracle {
    code: String,
    recognized: bool,
}

#[test]
fn a_new_typed_error_can_expose_metadata_without_an_erased_registration() {
    #[derive(Debug, thiserror::Error)]
    #[error("synthetic")]
    struct CustomError;
    impl DiagnosticError for CustomError {
        fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
            ErrorMetadata {
                name: "CustomError",
                code: Some("FIXTURE"),
            }
        }
    }
    let input = ErrorInput::Diagnostic(&CustomError);
    assert_eq!(diagnostic_error_code(input), "FIXTURE");
    assert!(has_node_error_code(input, "FIXTURE"));
}

#[cfg(unix)]
#[tokio::test]
async fn filesystem_diagnostics_match_bun_for_the_same_failed_operation_and_path() {
    let dir = tempfile::tempdir().unwrap();
    let (missing, directory, file) = (
        dir.path().join("missing"),
        dir.path().join("directory"),
        dir.path().join("file"),
    );
    fs::create_dir(&directory).await.unwrap();
    fs::write(&file, "test").await.unwrap();
    let errors = [
        fs::metadata(&missing).await.unwrap_err(),
        fs::create_dir(&directory).await.unwrap_err(),
        fs::read_dir(&file).await.unwrap_err(),
        fs::read(&directory).await.unwrap_err(),
        fs::read_link(&file).await.unwrap_err(),
        fs::metadata(file.join("child")).await.unwrap_err(),
    ];
    let output = Command::new("bun")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/errors_fs_oracle.ts"))
        .args([&missing, &directory, &file])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Vec<Oracle> = garcon_js::json::from_slice(&output.stdout).unwrap();
    assert_eq!(errors.len(), oracle.len());
    for (error, answer) in errors.iter().zip(oracle) {
        let input = ErrorInput::Error(error);
        assert_eq!(diagnostic_error_code(input), answer.code, "{error}");
        assert_eq!(
            has_node_error_code(input, &answer.code),
            answer.recognized,
            "{error}"
        );
    }
}

#[test]
fn typed_errors_preserve_their_code_or_original_class_name() {
    let git = GitServiceError::new(GitServiceErrorCode::GIT_INVALID_INPUT, "fixture");
    let terminal = TerminalError::new(TerminalErrorCode::TERMINAL_NOT_FOUND, "fixture");
    let time = PromiseTimeoutError::new("fixture", 10.0);
    let runtime = ServerRuntimeContractError::new("fixture");
    let chat = parse_chat_id(&Value::Null).unwrap_err();
    for (error, expected, is_code) in [
        (&git as &dyn std::error::Error, git.code.as_str(), true),
        (&terminal, "terminal-not-found", true),
        (&time, "PromiseTimeoutError", false),
        (&runtime, "ServerRuntimeContractError", false),
        (&chat, "InvalidChatIdError", false),
        (&MalformedJsonError, "MalformedJsonError", false),
        (&LockAborted, "AbortError", false),
    ] {
        let input = ErrorInput::Error(error);
        assert_eq!(diagnostic_error_code(input), expected);
        assert_eq!(has_node_error_code(input, expected), is_code);
    }
}

#[test]
fn typed_io_kinds_are_only_the_fallback_when_no_raw_code_is_present() {
    let error = io::Error::new(io::ErrorKind::PermissionDenied, "fixture");
    assert!(has_node_error_code(ErrorInput::Error(&error), "EACCES"));
    let error = io::Error::from_raw_os_error(-123_456);
    assert!(!has_node_error_code(ErrorInput::Error(&error), "EACCES"));
    assert_eq!(diagnostic_error_code(ErrorInput::Error(&error)), "Error");
}

#[cfg(unix)]
#[test]
fn maps_posix_errnos_used_by_the_runtime() {
    for (number, code) in [
        (libc::ENOENT, "ENOENT"),
        (libc::EACCES, "EACCES"),
        (libc::EPERM, "EPERM"),
        (libc::EEXIST, "EEXIST"),
        (libc::ENOTDIR, "ENOTDIR"),
        (libc::EISDIR, "EISDIR"),
        (libc::ELOOP, "ELOOP"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG"),
        (libc::EINVAL, "EINVAL"),
        (libc::EROFS, "EROFS"),
        (libc::EBUSY, "EBUSY"),
        (libc::ESRCH, "ESRCH"),
        (libc::ENOTCONN, "ENOTCONN"),
        (libc::ESTALE, "ESTALE"),
    ] {
        let error = io::Error::from_raw_os_error(number);
        assert!(
            has_node_error_code(ErrorInput::Error(&error), code),
            "{error}"
        );
    }
}

#[cfg(windows)]
#[test]
fn maps_win32_codes_to_buns_diagnostic_names() {
    use windows_sys::Win32::{
        Foundation::*,
        Networking::WinSock::{WSAEACCES, WSAENOTCONN},
    };
    for (number, code) in [
        (ERROR_FILE_NOT_FOUND as i32, "ENOENT"),
        (ERROR_ACCESS_DENIED as i32, "EPERM"),
        (WSAEACCES, "EACCES"),
        (ERROR_ALREADY_EXISTS as i32, "EEXIST"),
        (ERROR_DIRECTORY as i32, "ENOTDIR"),
        (ERROR_INVALID_FUNCTION as i32, "EISDIR"),
        (ERROR_CANT_RESOLVE_FILENAME as i32, "ELOOP"),
        (ERROR_FILENAME_EXCED_RANGE as i32, "ENAMETOOLONG"),
        (ERROR_INVALID_PARAMETER as i32, "EINVAL"),
        (ERROR_WRITE_PROTECT as i32, "EROFS"),
        (ERROR_SHARING_VIOLATION as i32, "EBUSY"),
        (WSAENOTCONN, "ENOTCONN"),
    ] {
        let error = io::Error::from_raw_os_error(number);
        assert!(
            has_node_error_code(ErrorInput::Error(&error), code),
            "{error}"
        );
    }
}
