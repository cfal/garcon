//! Ports common/garcon-agent-request.ts.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

pub const GARCON_AGENT_PROMPT_MAX_BYTES: usize = 48 * 1024;
pub static GARCON_AGENT_REF: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: this pattern uses only ASCII character classes and anchors.
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").expect("valid agent reference pattern")
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GarconAgentRequestOptions {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(rename = "async")]
    pub asynchronous: bool,
}

pub fn parse_garcon_agent_request_options(attributes: &Value) -> Option<GarconAgentRequestOptions> {
    let reference = attributes.get("ref")?.as_str()?;
    if !GARCON_AGENT_REF.is_match(reference) {
        return None;
    }
    let asynchronous = match attributes.get("async") {
        None => false,
        Some(value) if value == "true" => true,
        Some(value) if value == "false" => false,
        _ => return None,
    };
    Some(GarconAgentRequestOptions {
        reference: reference.to_owned(),
        asynchronous,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognizes_only_the_original_reference_and_async_strings() {
        let reference = format!("a{}", "._-".repeat(21));
        assert_eq!(
            parse_garcon_agent_request_options(&json!({"ref":reference})),
            Some(GarconAgentRequestOptions {
                reference,
                asynchronous: false
            })
        );
        assert!(
            parse_garcon_agent_request_options(&json!({"ref":"sample","async":"true"}))
                .unwrap()
                .asynchronous
        );
        for value in [
            json!({"ref":"_sample"}),
            json!({"ref":"x".repeat(65)}),
            json!({"ref":"sample\n"}),
            json!({"ref":"a\u{e9}"}),
            json!({"ref":"sample","async":"False"}),
            json!({"ref":"sample","async":true}),
            json!({"ref":"sample","async":null}),
        ] {
            assert_eq!(parse_garcon_agent_request_options(&value), None);
        }
    }
}
