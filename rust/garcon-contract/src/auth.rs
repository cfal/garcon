//! Ports common/auth.ts.

use garcon_js::{is_safe_integer, trim, utf16};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthSessionResponse {
    pub success: bool,
    pub user: AuthUser,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthUserResponse {
    pub user: AuthUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResponse {
    pub needs_setup: bool,
    pub is_authenticated: bool,
    pub auth_disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeUsernameRequest {
    pub current_password: String,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokenIdentity {
    pub owner_key: String,
    pub credential_revision: u64,
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LogoutResponse {
    pub success: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AuthValidationError(String);

impl AuthValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

fn record<'a>(
    value: &'a Value,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, AuthValidationError> {
    value
        .as_object()
        .filter(|record| record.keys().all(|key| keys.contains(&key.as_str())))
        .ok_or_else(|| AuthValidationError::new("Unexpected authentication fields."))
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, AuthValidationError> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AuthValidationError::new(format!("{field} is required.")))
}

pub fn validate_username(value: &Value) -> Result<&str, AuthValidationError> {
    let username = trim(text(value, "Username")?);
    if username.is_empty()
        || utf16::len(username) > 64
        || username
            .chars()
            .any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{2028}' | '\u{2029}'))
    {
        return Err(AuthValidationError::new("Username must contain 1-64 characters on one line without controls."));
    }
    Ok(username)
}

pub fn validate_password(value: &Value) -> Result<&str, AuthValidationError> {
    let password = current_password(value)?;
    if utf16::len(password) < 8 {
        return Err(AuthValidationError::new(
            "Password must be at least 8 characters.",
        ));
    }
    Ok(password)
}

fn current_password(value: &Value) -> Result<&str, AuthValidationError> {
    let password = text(value, "Password")?;
    if utf16::len(password) > 128 {
        return Err(AuthValidationError::new(
            "Password must be 128 characters or fewer.",
        ));
    }
    Ok(password)
}

fn field<'a>(raw: &'a Map<String, Value>, key: &str) -> &'a Value {
    raw.get(key).unwrap_or(&Value::Null)
}

pub fn parse_change_username_request(
    value: &Value,
) -> Result<ChangeUsernameRequest, AuthValidationError> {
    let raw = record(value, &["currentPassword", "username"])?;
    Ok(ChangeUsernameRequest {
        current_password: current_password(field(raw, "currentPassword"))?.to_owned(),
        username: validate_username(field(raw, "username"))?.to_owned(),
    })
}

pub fn parse_change_password_request(
    value: &Value,
) -> Result<ChangePasswordRequest, AuthValidationError> {
    let raw = record(value, &["currentPassword", "newPassword"])?;
    Ok(ChangePasswordRequest {
        current_password: current_password(field(raw, "currentPassword"))?.to_owned(),
        new_password: validate_password(field(raw, "newPassword"))?.to_owned(),
    })
}

pub fn parse_login_request(value: &Value) -> Result<LoginRequest, AuthValidationError> {
    let raw = record(value, &["username", "password"])?;
    Ok(LoginRequest {
        username: text(field(raw, "username"), "Username")?.to_owned(),
        password: current_password(field(raw, "password"))?.to_owned(),
    })
}

pub fn parse_register_request(value: &Value) -> Result<LoginRequest, AuthValidationError> {
    let raw = record(value, &["username", "password"])?;
    Ok(LoginRequest {
        username: validate_username(field(raw, "username"))?.to_owned(),
        password: validate_password(field(raw, "password"))?.to_owned(),
    })
}

pub fn parse_auth_user(value: &Value) -> Result<AuthUser, AuthValidationError> {
    let raw = record(value, &["id", "username"])?;
    Ok(AuthUser {
        id: text(field(raw, "id"), "Owner")?.to_owned(),
        username: text(field(raw, "username"), "Username")?.to_owned(),
    })
}

pub fn parse_auth_session_response(
    value: &Value,
) -> Result<AuthSessionResponse, AuthValidationError> {
    let raw = record(value, &["success", "user", "token"])?;
    if field(raw, "success").as_bool() != Some(true) {
        return Err(AuthValidationError::new("Invalid authentication response."));
    }
    Ok(AuthSessionResponse {
        success: true,
        user: parse_auth_user(field(raw, "user"))?,
        token: text(field(raw, "token"), "Token")?.to_owned(),
    })
}

pub fn parse_auth_user_response(value: &Value) -> Result<AuthUserResponse, AuthValidationError> {
    let raw = record(value, &["user"])?;
    Ok(AuthUserResponse {
        user: parse_auth_user(field(raw, "user"))?,
    })
}

pub fn parse_auth_status_response(
    value: &Value,
) -> Result<AuthStatusResponse, AuthValidationError> {
    let raw = record(value, &["needsSetup", "isAuthenticated", "authDisabled"])?;
    let (Some(needs_setup), Some(is_authenticated), Some(auth_disabled)) = (
        field(raw, "needsSetup").as_bool(),
        field(raw, "isAuthenticated").as_bool(),
        field(raw, "authDisabled").as_bool(),
    ) else {
        return Err(AuthValidationError::new("Invalid authentication status."));
    };
    Ok(AuthStatusResponse {
        needs_setup,
        is_authenticated,
        auth_disabled,
    })
}

pub fn parse_auth_token_identity(value: &Value) -> Option<AuthTokenIdentity> {
    let raw = value.as_object()?;
    let owner_key = raw.get("sub")?.as_str().filter(|owner| !owner.is_empty())?;
    let revision = raw.get("credentialRevision")?.as_f64()?;
    if !is_safe_integer(revision) || revision < 1.0 {
        return None;
    }
    let sid = raw.get("sid")?;
    if !is_auth_session_id(sid) {
        return None;
    }
    Some(AuthTokenIdentity {
        owner_key: owner_key.to_owned(),
        credential_revision: revision as u64,
        session_id: sid.as_str()?.to_owned(),
    })
}

pub fn is_auth_session_id(value: &Value) -> bool {
    value.as_str().is_some_and(|sid| {
        utf16::len(sid) == 64
            && sid
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn separate_credential_contracts_never_admit_a_combined_or_blank_password_update() {
        let input = json!({"currentPassword":" exact ","username":" owner "});
        assert_eq!(
            parse_change_username_request(&input),
            Ok(ChangeUsernameRequest {
                current_password: " exact ".to_owned(),
                username: "owner".to_owned()
            })
        );
        assert!(
            parse_change_username_request(&json!({
                "currentPassword":"password","username":"owner","newPassword":"password-next"
            }))
            .is_err()
        );
        assert_eq!(
            parse_change_password_request(&json!({"currentPassword":"password","newPassword":""})),
            Err(AuthValidationError::new("Password is required."))
        );
        assert!(
            parse_change_password_request(&json!({
                "currentPassword":"password","newPassword":"password","confirmation":"password"
            }))
            .is_err()
        );
        assert_eq!(validate_password(&json!(" password ")), Ok(" password "));
    }

    #[test]
    fn new_usernames_remain_compatible_with_ticket_labels_and_password_limits_remain_exact() {
        for invalid_name in ["", " ", &"x".repeat(65), "a\nb", "a\u{2028}b", "a\0b"] {
            assert!(validate_username(&json!(invalid_name)).is_err());
        }
        assert_eq!(
            utf16::len(validate_username(&json!("\u{1f600}".repeat(32))).unwrap()),
            64
        );
        assert_eq!(validate_username(&json!("\u{fffd}")), Ok("\u{fffd}"));
        assert_eq!(
            validate_password(&json!("\u{1f600}".repeat(64)))
                .unwrap()
                .encode_utf16()
                .count(),
            128
        );
        assert!(validate_password(&json!("x".repeat(7))).is_err());
        assert!(validate_password(&json!("x".repeat(129))).is_err());
    }

    #[test]
    fn session_responses_and_token_identity_metadata_are_validated_not_asserted() {
        let response = json!({"success":true,"user":{"id":"owner-before","username":"owner-after"},"token":"token"});
        assert_eq!(
            parse_auth_session_response(&response).unwrap().user.id,
            "owner-before"
        );
        let malformed = json!({"success":true,"user":{"username":"owner"},"token":""});
        assert_eq!(
            parse_auth_session_response(&malformed),
            Err(AuthValidationError::new("Owner is required."))
        );

        let sid = "a".repeat(64);
        let mut claims = json!({"sub":"owner","credentialRevision":1,"sid":sid});
        assert_eq!(
            parse_auth_token_identity(&claims),
            Some(AuthTokenIdentity {
                owner_key: "owner".to_owned(),
                credential_revision: 1,
                session_id: sid.clone(),
            })
        );
        for malformed_sid in [
            Value::Null,
            json!(""),
            json!("a".repeat(63)),
            json!("z".repeat(64)),
        ] {
            claims["sid"] = malformed_sid;
            assert_eq!(parse_auth_token_identity(&claims), None);
        }
        claims["sid"] = json!(sid);
        for revision in [
            json!(0),
            json!(-1),
            json!(0.5),
            json!(9007199254740992_u64),
            json!("1"),
        ] {
            claims["credentialRevision"] = revision;
            assert_eq!(parse_auth_token_identity(&claims), None);
        }
    }

    #[test]
    fn auth_probes_reject_malformed_users_and_status_flags() {
        let user = json!({"id":"original-owner","username":"current-name"});
        let response = json!({"user":user});
        assert_eq!(
            json!(parse_auth_user_response(&response).unwrap()),
            response
        );
        for malformed in [
            json!({}),
            json!({"user":{"id":"","username":"name"}}),
            json!({"user":user,"token":"unexpected"}),
        ] {
            assert!(parse_auth_user_response(&malformed).is_err());
        }
        let mut status = json!({"needsSetup":false,"isAuthenticated":false,"authDisabled":false});
        assert_eq!(json!(parse_auth_status_response(&status).unwrap()), status);
        status["needsSetup"] = json!("false");
        assert_eq!(
            parse_auth_status_response(&status),
            Err(AuthValidationError::new("Invalid authentication status."))
        );
        status["user"] = user;
        assert_eq!(
            parse_auth_status_response(&status),
            Err(AuthValidationError::new(
                "Unexpected authentication fields."
            ))
        );
    }
}
