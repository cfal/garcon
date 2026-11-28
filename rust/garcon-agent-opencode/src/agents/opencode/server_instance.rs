//! Ports `server-agents/opencode/src/agents/opencode/server-instance.ts`.

use std::error::Error;

use garcon_js::OptionalNullable;
use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::jsonc::{self, ParseOptions};
use super::session_identity_plugin::resolve_session_identity_plugin_url;
use crate::js::error;

// The environment a child receives: every variable of the parent. A variable
// the parent lists without a value is absent there, and one it lists as
// `null` is kept apart from it, because the original writes the two apart.
pub type ServerEnvironment = IndexMap<String, OptionalNullable<String>>;

/// `process.env` for a spawn: each variable in the order the parent lists them.
pub fn process_environment() -> ServerEnvironment {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                OptionalNullable::some(value.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

fn plugin_specifier(entry: &Value) -> Option<&str> {
    if let Some(specifier) = entry.as_str() {
        return Some(specifier);
    }
    let entry = entry.as_array()?;
    if entry.len() != 2 {
        return None;
    }
    let specifier = entry[0].as_str()?;
    // `entry[1] !== null && typeof entry[1] === 'object' && !Array.isArray(entry[1])`
    let options = &entry[1];
    if !options.is_object() {
        return None;
    }
    Some(specifier)
}

pub fn merge_open_code_config_content(
    inherited_content: Option<&str>,
    session_identity_plugin_url: &str,
) -> Result<String, Box<dyn Error>> {
    let invalid = |detail: &str| {
        error(
            "Error",
            format!("Invalid inherited OPENCODE_CONFIG_CONTENT{detail}"),
        )
    };
    let mut inherited = Value::Object(Map::new());
    if let Some(content) = inherited_content.filter(|content| !garcon_js::trim(content).is_empty())
    {
        let (parsed, errors) = jsonc::parse(
            content,
            ParseOptions {
                disallow_comments: false,
                allow_trailing_comma: true,
                allow_empty_content: false,
            },
        );
        if let Some(first) = errors.first() {
            return Err(error(
                "Error",
                format!(
                    "Invalid inherited OPENCODE_CONFIG_CONTENT at offset {}: {}.",
                    first.offset,
                    first.code.name()
                ),
            ));
        }
        inherited = parsed.unwrap_or(Value::Null);
    }
    let mut config = match inherited {
        Value::Object(config) => config,
        _ => return Err(invalid(": expected a JSONC object.")),
    };

    if config
        .get("plugin")
        .is_some_and(|plugin| !plugin.is_array())
    {
        return Err(invalid(": \"plugin\" must be an array."));
    }
    let plugins: &[Value] = config
        .get("plugin")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    if let Some(invalid_plugin_index) = plugins
        .iter()
        .position(|entry| plugin_specifier(entry).is_none())
    {
        return Err(error(
            "Error",
            format!(
                "Invalid inherited OPENCODE_CONFIG_CONTENT: \"plugin[{invalid_plugin_index}]\" must be a string or [specifier, options] tuple."
            ),
        ));
    }
    // The last entry that already names the plugin is kept as it is, options included.
    let session_identity_plugin_entry = plugins
        .iter()
        .rev()
        .find(|entry| plugin_specifier(entry) == Some(session_identity_plugin_url))
        .cloned()
        .unwrap_or_else(|| Value::String(session_identity_plugin_url.to_owned()));
    let mut plugins_kept: Vec<Value> = plugins
        .iter()
        .filter(|entry| plugin_specifier(entry) != Some(session_identity_plugin_url))
        .cloned()
        .collect();
    plugins_kept.push(session_identity_plugin_entry);
    // A `plugin` already in the configuration keeps its place, as spreading does.
    config.insert("plugin".to_owned(), Value::Array(plugins_kept));
    Ok(garcon_js::json::stringify(&Value::Object(config)))
}

/// The environment `opencode serve` runs with: the base environment without
/// the ambient session identity and pure mode, its inline configuration
/// carrying the Garcon plugin, and provider-managed updates off.
pub fn build_open_code_server_env(
    base_env: Option<&ServerEnvironment>,
    session_identity_plugin_url: Option<&str>,
    platform: Option<&str>,
) -> Result<ServerEnvironment, Box<dyn Error>> {
    let process_env;
    let base_env = match base_env {
        Some(base_env) => base_env,
        None => {
            process_env = process_environment();
            &process_env
        }
    };
    let plugin_url;
    let session_identity_plugin_url = match session_identity_plugin_url {
        Some(url) => url,
        None => {
            plugin_url = resolve_session_identity_plugin_url()?;
            plugin_url.as_str()
        }
    };
    let platform = platform.unwrap_or(process_platform());
    let mut server_env = base_env.clone();
    let mut inherited_config_content = server_env
        .get("OPENCODE_CONFIG_CONTENT")
        .and_then(|value| value.as_deref())
        .map(str::to_owned);
    for key in base_env.keys() {
        let normalized_key = if platform == "win32" {
            key.to_uppercase()
        } else {
            key.clone()
        };
        if normalized_key == "OPENCODE_CONFIG_CONTENT" {
            // The first variable of that name that has a value is the inherited one.
            if inherited_config_content.is_none() {
                inherited_config_content = server_env
                    .shift_remove(key)
                    .and_then(|value| value.as_deref().map(str::to_owned));
            } else {
                server_env.shift_remove(key);
            }
        } else if normalized_key == "OPENCODE_PURE" || normalized_key == "OPENCODE_SESSION_ID" {
            server_env.shift_remove(key);
        }
    }
    server_env.insert(
        "OPENCODE_CONFIG_CONTENT".to_owned(),
        OptionalNullable::some(merge_open_code_config_content(
            inherited_config_content.as_deref(),
            session_identity_plugin_url,
        )?),
    );
    server_env.insert(
        "OPENCODE_DISABLE_AUTOUPDATE".to_owned(),
        OptionalNullable::some("1".to_owned()),
    );
    Ok(server_env)
}

// `process.platform`, in the names Node gives it.
fn process_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}
