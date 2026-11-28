//! Ports `session-identity-plugin.test.js` and
//! `autocompaction-architecture.test.js`.
//!
//! The two tests that run the plugin's `shell.env` hook are not ported: the
//! plugin stays JavaScript because OpenCode loads it, and the original's test
//! keeps running it. The port embeds that file byte for byte.

use garcon_agent_opencode::agents::opencode::server_instance::{
    ServerEnvironment, build_open_code_server_env, merge_open_code_config_content,
};
use garcon_agent_opencode::agents::opencode::session_identity_plugin::{
    GARCON_SESSION_IDENTITY_PLUGIN, path_to_file_url, resolve_session_identity_plugin_url,
};
use garcon_js::OptionalNullable;
use serde_json::Value;

const GARCON_PLUGIN_URL: &str = "file:///opt/garcon/garcon-session-identity.mjs";
const CRATE: &str = env!("CARGO_MANIFEST_DIR");

fn merge(inherited_content: Option<&str>) -> Result<Value, Box<dyn std::error::Error>> {
    let merged = merge_open_code_config_content(inherited_content, GARCON_PLUGIN_URL)?;
    Ok(garcon_js::json::parse(&merged)?)
}

fn environment(variables: &[(&str, &str)]) -> ServerEnvironment {
    variables
        .iter()
        .map(|(key, value)| {
            (
                (*key).to_owned(),
                OptionalNullable::some((*value).to_owned()),
            )
        })
        .collect()
}

fn variable<'a>(environment: &'a ServerEnvironment, key: &str) -> Option<&'a str> {
    environment.get(key).and_then(|value| value.as_deref())
}

fn built(variables: &[(&str, &str)], platform: &str) -> ServerEnvironment {
    build_open_code_server_env(
        Some(&environment(variables)),
        Some(GARCON_PLUGIN_URL),
        Some(platform),
    )
    .expect("the server environment builds")
}

#[test]
fn adds_the_garcon_plugin_without_inherited_inline_content() {
    assert_eq!(
        merge(None).expect("merged"),
        serde_json::json!({ "plugin": [GARCON_PLUGIN_URL] })
    );
}

#[test]
fn treats_blank_inherited_inline_content_as_absent() {
    assert_eq!(
        merge(Some("  \n")).expect("merged"),
        serde_json::json!({ "plugin": [GARCON_PLUGIN_URL] })
    );
}

#[test]
fn preserves_jsonc_fields_string_plugins_and_plugin_tuples() {
    let content = r#"{
      // Operator-owned inline settings stay intact.
      "mode": "user",
      "plugin": [
        "file:///opt/user/plugin.js",
        ["package-plugin", { "enabled": true }],
      ],
    }"#;

    assert_eq!(
        merge(Some(content)).expect("merged"),
        serde_json::json!({
            "mode": "user",
            "plugin": [
                "file:///opt/user/plugin.js",
                ["package-plugin", { "enabled": true }],
                GARCON_PLUGIN_URL,
            ],
        })
    );
}

#[test]
fn does_not_duplicate_an_identical_garcon_plugin_tuple() {
    let existing = serde_json::json!([GARCON_PLUGIN_URL, { "configured": true }]);
    let merged = merge(Some(
        &serde_json::json!({ "plugin": ["user-plugin", existing] }).to_string(),
    ))
    .expect("merged");

    assert_eq!(
        merged["plugin"],
        serde_json::json!(["user-plugin", existing])
    );
}

#[test]
fn preserves_url_sensitive_path_characters_through_a_file_url() {
    let plugin_url = path_to_file_url("/opt/Garçon plugins/100% session #1.mjs");
    assert_eq!(
        plugin_url,
        "file:///opt/Gar%C3%A7on%20plugins/100%25%20session%20%231.mjs"
    );
    let merged = merge_open_code_config_content(None, &plugin_url).expect("merged");

    assert_eq!(
        garcon_js::json::parse(&merged).expect("JSON"),
        serde_json::json!({ "plugin": [plugin_url] })
    );
}

#[test]
fn fails_clearly_for_invalid_inherited_configuration() {
    for (content, expected) in [
        (
            "{ broken",
            "Invalid inherited OPENCODE_CONFIG_CONTENT at offset",
        ),
        (
            "{} trailing",
            "Invalid inherited OPENCODE_CONFIG_CONTENT at offset",
        ),
        (
            "[]",
            "Invalid inherited OPENCODE_CONFIG_CONTENT: expected a JSONC object.",
        ),
        (
            "{ \"plugin\": \"wrong\" }",
            "Invalid inherited OPENCODE_CONFIG_CONTENT: \"plugin\" must be an array.",
        ),
        (
            "{ \"plugin\": [[\"incomplete\"]] }",
            "Invalid inherited OPENCODE_CONFIG_CONTENT: \"plugin[0]\" must be a string or [specifier, options] tuple.",
        ),
    ] {
        let error = merge(Some(content)).expect_err("refused");
        assert!(error.to_string().contains(expected), "{content:?}: {error}");
    }
}

#[test]
fn removes_ambient_identity_and_pure_mode_while_preserving_merged_configuration() {
    let built = built(
        &[
            ("KEEP_ME", "yes"),
            ("OPENCODE_CONFIG_CONTENT", "{ \"formatter\": false }"),
            ("OPENCODE_PURE", "1"),
            ("OPENCODE_SESSION_ID", "ambient-session"),
        ],
        "linux",
    );

    assert!(built.get("OPENCODE_PURE").is_none());
    assert!(built.get("OPENCODE_SESSION_ID").is_none());
    assert_eq!(variable(&built, "KEEP_ME"), Some("yes"));
    assert_eq!(
        garcon_js::json::parse(
            variable(&built, "OPENCODE_CONFIG_CONTENT").expect("merged content")
        )
        .expect("JSON"),
        serde_json::json!({ "formatter": false, "plugin": [GARCON_PLUGIN_URL] })
    );
}

#[test]
fn removes_case_insensitive_ambient_aliases_on_windows() {
    let built = built(
        &[
            ("Opencode_Config_Content", "{ \"formatter\": false }"),
            ("opencode_pure", "1"),
            ("opencode_session_id", "ambient-session"),
        ],
        "win32",
    );

    assert!(built.get("Opencode_Config_Content").is_none());
    assert!(built.get("opencode_pure").is_none());
    assert!(built.get("opencode_session_id").is_none());
    assert_eq!(
        garcon_js::json::parse(
            variable(&built, "OPENCODE_CONFIG_CONTENT").expect("merged content")
        )
        .expect("JSON"),
        serde_json::json!({ "formatter": false, "plugin": [GARCON_PLUGIN_URL] })
    );
}

#[test]
fn resolves_the_plugin_through_an_absolute_file_url() {
    let plugin_url = resolve_session_identity_plugin_url().expect("the plugin URL");

    assert!(plugin_url.starts_with("file://"));
    let plugin_path = percent_decode(plugin_url.trim_start_matches("file://"));
    assert_eq!(
        std::fs::read_to_string(&plugin_path).expect("the plugin file"),
        GARCON_SESSION_IDENTITY_PLUGIN
    );
    // A second request answers with the file this process already wrote.
    assert_eq!(
        resolve_session_identity_plugin_url().expect("the plugin URL"),
        plugin_url
    );
}

#[cfg(unix)]
#[test]
fn removes_the_private_plugin_directory_when_the_owner_exits() {
    let path = std::thread::spawn(|| {
        let url = resolve_session_identity_plugin_url().expect("the plugin URL");
        let path = std::path::PathBuf::from(percent_decode(url.trim_start_matches("file://")));
        assert!(path.is_file());
        path.parent().expect("the private directory").to_owned()
    })
    .join()
    .expect("the plugin owner exits");

    assert!(!path.exists());
}

#[test]
fn includes_the_dependency_free_plugin_in_the_build() {
    let checked_in = std::fs::read_to_string(format!(
        "{CRATE}/../../server-agents/opencode/src/agents/opencode/garcon-session-identity.mjs"
    ))
    .expect("the checked-in plugin");

    assert_eq!(GARCON_SESSION_IDENTITY_PLUGIN, checked_in);
}

#[test]
fn does_not_force_autocompaction_off_and_preserves_operator_overrides() {
    let environment = built(
        &[
            ("KEEP_ME", "yes"),
            ("OPENCODE_DISABLE_AUTOCOMPACT", "0"),
            ("OPENCODE_DISABLE_AUTOUPDATE", "0"),
            ("OPENCODE_PURE", "1"),
        ],
        "linux",
    );
    let config = garcon_js::json::parse(
        variable(&environment, "OPENCODE_CONFIG_CONTENT").expect("merged content"),
    )
    .expect("JSON");

    assert_eq!(config["plugin"].as_array().expect("plugins").len(), 1);
    assert_eq!(variable(&environment, "KEEP_ME"), Some("yes"));
    assert_eq!(
        variable(&environment, "OPENCODE_DISABLE_AUTOCOMPACT"),
        Some("0")
    );
    assert_eq!(
        variable(&environment, "OPENCODE_DISABLE_AUTOUPDATE"),
        Some("1")
    );
    assert!(
        built(&[], "linux")
            .get("OPENCODE_DISABLE_AUTOCOMPACT")
            .is_none()
    );
    assert!(environment.get("OPENCODE_PURE").is_none());
}

#[test]
fn keeps_compaction_enabled_without_the_retired_operation_identity_plugin() {
    let server_instance =
        std::fs::read_to_string(format!("{CRATE}/src/agents/opencode/server_instance.rs"))
            .expect("the port's server module");

    assert!(!server_instance.contains("OPENCODE_DISABLE_AUTOCOMPACT"));
    assert!(!server_instance.contains("operation-identity-plugin"));
    assert!(!server_instance.contains("'--pure'"));
    // The plugin the compiled original extracts at startup is embedded instead.
    assert!(GARCON_SESSION_IDENTITY_PLUGIN.contains("'shell.env'"));
}

// Reads the path of a `file:` URL the port wrote.
fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("hex digits");
            decoded.push(u8::from_str_radix(hex, 16).expect("a byte"));
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).expect("UTF-8")
}
