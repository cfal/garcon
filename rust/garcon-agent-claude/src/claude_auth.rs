use std::{ffi::OsStr, process::Stdio};

use garcon_js::{json, trim};
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub authenticated: bool,
    pub can_reauth: bool,
    pub label: String,
}

fn parse_claude_auth_status(output: &str) -> Option<Value> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    let payload = json::parse(output.get(start..=end)?).ok()?;
    payload.is_object().then_some(payload)
}

pub async fn get_claude_auth_status(
    binary: &OsStr,
    anthropic_base_url: Option<&str>,
    anthropic_api_key: Option<&str>,
) -> ClaudeAuthStatus {
    if anthropic_base_url.is_some_and(|url| !url.is_empty())
        || anthropic_api_key.is_some_and(|key| !key.is_empty())
    {
        return ClaudeAuthStatus {
            authenticated: true,
            can_reauth: false,
            label: String::new(),
        };
    }

    // Running the CLI follows its own configuration directory and auth storage rules.
    let output = Command::new(binary)
        .args(["auth", "status"])
        .stdin(Stdio::null())
        .output()
        .await;
    let Ok(output) = output else {
        return ClaudeAuthStatus {
            authenticated: false,
            can_reauth: true,
            label: String::new(),
        };
    };
    if !output.status.success() {
        return ClaudeAuthStatus {
            authenticated: false,
            can_reauth: true,
            label: String::new(),
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let output = [trim(&stdout), trim(&stderr)]
        .into_iter()
        .filter(|output| !output.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(status) = parse_claude_auth_status(&output)
        && status["loggedIn"] == true
    {
        return ClaudeAuthStatus {
            authenticated: true,
            can_reauth: status["authMethod"] != "api_key",
            label: status["email"].as_str().unwrap_or_default().to_owned(),
        };
    }
    ClaudeAuthStatus {
        authenticated: true,
        can_reauth: true,
        label: String::new(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};

    use super::*;

    async fn compare_original(
        binary: &Path,
        base_url: Option<&str>,
        api_key: Option<&str>,
        status: &ClaudeAuthStatus,
    ) {
        let original = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/claude-auth.ts"
            ))
            .arg(binary)
            .arg(base_url.unwrap_or_default())
            .arg(api_key.unwrap_or_default())
            .output()
            .await
            .unwrap();
        assert!(
            original.status.success(),
            "{}",
            String::from_utf8_lossy(&original.stderr)
        );
        assert_eq!(
            String::from_utf8(original.stdout).unwrap(),
            serde_json::to_string(status).unwrap()
        );
    }

    #[tokio::test]
    async fn reads_only_the_configured_cli_and_short_circuits_environment_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("fake-claude-auth");
        for (script, expected) in [
            (
                r#"printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","email":"synthetic@example.invalid"}'"#,
                (true, true, "synthetic@example.invalid"),
            ),
            (
                r#"printf '%s\n' 'synthetic warning' '{"loggedIn":true,"authMethod":"api_key"}' >&2"#,
                (true, false, ""),
            ),
            ("printf '%s\n' 'synthetic non-JSON'", (true, true, "")),
            ("exit 1", (false, true, "")),
        ] {
            fs::write(
                &binary,
                format!(
                    "#!/bin/sh\n[ \"$1\" = auth ] && [ \"$2\" = status ] || exit 2\n{script}\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
            let status = get_claude_auth_status(binary.as_os_str(), None, None).await;
            compare_original(&binary, None, None, &status).await;
            assert_eq!(
                (
                    status.authenticated,
                    status.can_reauth,
                    status.label.as_str()
                ),
                expected
            );
        }

        let missing = directory.path().join("must-not-spawn");
        for (base, key) in [
            (Some("http://synthetic.invalid"), None),
            (None, Some("synthetic-key")),
        ] {
            let status = get_claude_auth_status(missing.as_os_str(), base, key).await;
            assert!(status.authenticated);
            assert!(!status.can_reauth);
            compare_original(&missing, base, key, &status).await;
        }
        let status = get_claude_auth_status(missing.as_os_str(), None, None).await;
        assert!(!status.authenticated);
        compare_original(&missing, None, None, &status).await;
    }
}
