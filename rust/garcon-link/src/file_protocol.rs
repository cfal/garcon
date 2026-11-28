//! Ports `server/remote/transport/file-protocol.ts`.

use base64::{Engine, engine::general_purpose::STANDARD};
use garcon_base::domain_error::DomainError;
use garcon_contract::{error_codes::ErrorCode, file_contracts::MAX_FILE_VIEW_BYTES};
use garcon_js::utf16;
use serde_json::Value;

pub fn decode_file_data(value: &Value) -> Result<Vec<u8>, DomainError> {
    let value = value.as_str().ok_or_else(invalid_file_data)?;
    if utf16::len(value) > 4 * MAX_FILE_VIEW_BYTES.div_ceil(3) {
        return Err(file_too_large());
    }
    let Ok(bytes) = STANDARD.decode(value) else {
        // Buffer.from counts even noncanonical digits before checking the limit.
        let digits = value
            .bytes()
            .take_while(|&byte| byte != b'=')
            .filter(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'-' | b'_')
            })
            .count();
        return Err(if digits * 6 / 8 > MAX_FILE_VIEW_BYTES {
            file_too_large()
        } else {
            invalid_file_data()
        });
    };
    if bytes.len() > MAX_FILE_VIEW_BYTES {
        return Err(file_too_large());
    }
    if STANDARD.encode(&bytes) != value {
        return Err(invalid_file_data());
    }
    Ok(bytes)
}

pub fn decode_file_text(value: &Value) -> Result<String, DomainError> {
    String::from_utf8(decode_file_data(value)?).map_err(|_| invalid_file_data())
}

pub fn invalid_file_data() -> DomainError {
    DomainError::new(
        ErrorCode::FILE_INVALID_DATA,
        "Invalid file request or response",
        400,
        false,
    )
}

fn file_too_large() -> DomainError {
    DomainError::new(
        ErrorCode::FILE_TOO_LARGE,
        "File exceeds the 4 MiB limit",
        413,
        false,
    )
}

pub fn validate_file_rpc_request(method: &str, request: &Value) -> Result<(), DomainError> {
    let request = request.as_object().ok_or_else(invalid_file_data)?;
    let valid_path = |value: Option<&Value>| {
        value.and_then(Value::as_str).is_some_and(|value| {
            !value.is_empty() && utf16::len(value) <= 4096 && !value.contains('\0')
        })
    };
    let valid = match method {
        "files.tree" | "files.browse" => {
            !request.contains_key("directoryPath") || valid_path(request.get("directoryPath"))
        }
        "files.createDirectory" => {
            valid_path(request.get("parentPath"))
                && request
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| utf16::len(name) <= 4096)
        }
        _ => {
            valid_path(request.get("projectPath"))
                && (method == "files.list" || valid_path(request.get("filePath")))
        }
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_file_data())
    }
}
