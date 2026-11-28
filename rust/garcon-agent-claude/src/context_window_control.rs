use std::future::Future;

use garcon_interface::resources::ExecutorResult;
use garcon_js::json::{Opaque, as_number};
use serde_json::{Map, Value, json};

pub async fn update_claude_context_window<Fut: Future<Output = ExecutorResult<Opaque>>>(
    mut request: impl FnMut(Opaque) -> Fut,
    current_model: &str,
    model: &str,
    auto_compact_window: u32,
) -> ExecutorResult<()> {
    let settings = request(json!({ "subtype": "get_settings" }).into()).await?;
    let mut env = flag_settings_environment(&settings)?;
    // Direct settings ACKs need not change the live budget; the stdin-only flag environment does.
    // https://code.claude.com/docs/en/model-config#set-the-auto-compact-window
    env.insert(
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_owned(),
        Value::String(auto_compact_window.to_string()),
    );
    request(json!({ "subtype": "apply_flag_settings", "settings": { "env": env } }).into()).await?;
    if model != current_model {
        request(json!({ "subtype": "set_model", "model": model }).into()).await?;
    }
    let usage = request(json!({ "subtype": "get_context_usage" }).into()).await?;
    // Claude may omit an ineffective [1m] suffix from the reported model ID.
    // https://github.com/anthropics/claude-code/blob/80c6959d28c4c30ecd14fc1cdf172f19d9adad81/CHANGELOG.md#L295
    if !usage.is_object()
        || (usage["model"] != model
            && usage["model"] != model.strip_suffix("[1m]").unwrap_or(model))
        || usage["autocompactSource"] != "env"
        || as_number(&usage["rawMaxTokens"]) != Some(f64::from(auto_compact_window))
    {
        return Err("Claude CLI did not apply the requested context window".into());
    }
    Ok(())
}

fn flag_settings_environment(response: &Value) -> ExecutorResult<Map<String, Value>> {
    let sources = response["sources"]
        .as_array()
        .ok_or("Claude CLI returned invalid settings sources")?;
    if !sources.iter().all(|source| source["source"].is_string()) {
        return Err("Claude CLI returned invalid settings sources".into());
    }
    let mut flags = sources
        .iter()
        .filter(|source| source["source"] == "flagSettings");
    let Some(flag) = flags.next() else {
        return Ok(Map::new());
    };
    if flags.next().is_some() || !flag["settings"].is_object() {
        return Err("Claude CLI returned invalid flag settings".into());
    }
    let Some(env) = flag["settings"].get("env") else {
        return Ok(Map::new());
    };
    let env = env
        .as_object()
        .filter(|map| map.values().all(Value::is_string))
        .ok_or("Claude CLI returned invalid flag environment")?;
    Ok(env.clone())
}

#[cfg(test)]
mod tests {
    use std::future::ready;

    use super::*;

    #[tokio::test]
    async fn preserves_only_flag_environment_and_verifies_the_live_window_after_switching() {
        let settings = json!({ "effective": { "env": { "EFFECTIVE_ONLY":"not-a-flag" } }, "sources": [
            { "source":"userSettings", "settings": { "env": { "USER_ONLY":"not-a-flag" } } },
            { "source":"flagSettings", "settings": { "env": { "SYNTHETIC_KEY":"fixture", "CLAUDE_CODE_AUTO_COMPACT_WINDOW":"922000" } } },
        ] });
        let model = "synthetic-next[1m]";
        let mut commands = Vec::new();
        update_claude_context_window(|request| {
            let response = match request["subtype"].as_str().unwrap() {
                "get_settings" => settings.clone(),
                "get_context_usage" => json!({ "model":"synthetic-next", "autocompactSource":"env", "rawMaxTokens":850000 }),
                _ => json!({}),
            };
            commands.push(request.into_value());
            ready(Ok(response.into()))
        }, "synthetic-previous[1m]", model, 850000).await.unwrap();
        assert_eq!(
            commands,
            [
                json!({ "subtype":"get_settings" }),
                json!({ "subtype":"apply_flag_settings", "settings": { "env": { "SYNTHETIC_KEY":"fixture", "CLAUDE_CODE_AUTO_COMPACT_WINDOW":"850000" } } }),
                json!({ "subtype":"set_model", "model": model }),
                json!({ "subtype":"get_context_usage" }),
            ]
        );
    }

    #[tokio::test]
    async fn rejects_malformed_settings_before_mutating_the_cli() {
        for settings in [
            Value::Null,
            json!({}),
            json!({ "sources": null }),
            json!({ "sources": [null] }),
            json!({ "sources": [{}] }),
            json!({ "sources": [{ "source":"flagSettings" }] }),
            json!({ "sources": [{ "source":"flagSettings", "settings": null }] }),
            json!({ "sources": [{ "source":"flagSettings", "settings": {"env": null} }] }),
            json!({ "sources": [{ "source":"flagSettings", "settings": {"env": []} }] }),
            json!({ "sources": [{ "source":"flagSettings", "settings": {"env": {"INVALID": 1}} }] }),
            json!({ "sources": [{ "source":"flagSettings", "settings": {} }, { "source":"flagSettings", "settings": {} }] }),
        ] {
            let mut requests = Vec::new();
            let error = update_claude_context_window(
                |request| {
                    requests.push(request["subtype"].as_str().unwrap().to_owned());
                    ready(Ok(settings.clone().into()))
                },
                "synthetic-previous[1m]",
                "synthetic-next[1m]",
                850000,
            )
            .await
            .unwrap_err();
            assert!(error.to_string().starts_with("Claude CLI returned invalid"));
            assert_eq!(requests, ["get_settings"]);
        }
    }

    #[tokio::test]
    async fn verifies_the_budget_even_if_all_controls_ack_and_skips_redundant_model_changes() {
        let model = "synthetic-next[1m]";
        for usage in [
            Value::Null,
            json!({}),
            json!({ "model":"foreign", "autocompactSource":"env", "rawMaxTokens":850000 }),
            json!({ "model":model, "autocompactSource":"settings", "rawMaxTokens":850000 }),
            json!({ "model":model, "autocompactSource":"env", "rawMaxTokens":"850000" }),
            json!({ "model":"synthetic-next", "autocompactSource":"env", "rawMaxTokens":922000 }),
        ] {
            let mut commands = Vec::new();
            let error = update_claude_context_window(
                |request| {
                    let subtype = request["subtype"].as_str().unwrap();
                    commands.push(subtype.to_owned());
                    ready(Ok(match subtype {
                        "get_settings" => json!({ "sources": [] }),
                        "get_context_usage" => usage.clone(),
                        _ => json!({}),
                    }
                    .into()))
                },
                model,
                model,
                850000,
            )
            .await
            .unwrap_err();
            assert_eq!(
                commands,
                ["get_settings", "apply_flag_settings", "get_context_usage"]
            );
            assert_eq!(
                error.to_string(),
                "Claude CLI did not apply the requested context window"
            );
        }
    }

    #[tokio::test]
    async fn propagates_each_control_error_before_sending_later_controls() {
        for fail in [
            "get_settings",
            "apply_flag_settings",
            "set_model",
            "get_context_usage",
        ] {
            let mut commands = Vec::new();
            let error = update_claude_context_window(
                |request| {
                    let subtype = request["subtype"].as_str().unwrap();
                    commands.push(subtype.to_owned());
                    ready(if subtype == fail {
                        Err("synthetic control failure".into())
                    } else {
                        Ok(json!({ "sources": [] }).into())
                    })
                },
                "synthetic-previous",
                "synthetic-next",
                850000,
            )
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), "synthetic control failure");
            assert_eq!(commands.last().map(String::as_str), Some(fail));
        }
    }
}
