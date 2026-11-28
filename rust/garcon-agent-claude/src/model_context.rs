use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelContext {
    pub model: String,
    pub auto_compact_window: Option<u32>,
}

pub fn resolve_claude_model(model: &str) -> Result<ClaudeModelContext, AgentIntegrationError> {
    if let Some((base, suffix)) = model.split_once('[') {
        let annotation = suffix
            .strip_suffix(']')
            .filter(|text| !text.is_empty() && !text.contains(['[', ']']))
            .filter(|_| !base.is_empty() && !base.contains(']'))
            .ok_or_else(invalid_context_suffix)?;

        if let Some(thousands) = annotation
            .strip_suffix(['k', 'K'])
            .filter(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
            .filter(|_| !base.contains(['\r', '\n', '\u{2028}', '\u{2029}']))
        {
            let thousands = thousands
                .parse::<u32>()
                .map_err(|_| invalid_context_suffix())?;
            if garcon_js::trim(base).is_empty() || !(100..=1000).contains(&thousands) {
                return Err(invalid_context_suffix());
            }
            return Ok(ClaudeModelContext {
                model: format!("{base}[1m]"),
                auto_compact_window: Some(thousands * 1_000),
            });
        }
    } else if model.contains(']') {
        return Err(invalid_context_suffix());
    }

    Ok(ClaudeModelContext {
        model: model.to_owned(),
        auto_compact_window: None,
    })
}

fn invalid_context_suffix() -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_SETTINGS,
        "Claude model context suffix requires a model followed by [100k] through [1000k].",
        false,
        None,
    )
}
