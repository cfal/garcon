use std::rc::Rc;

use garcon_agent_claude::{claude_catalog, claude_descriptor, claude_settings};
use garcon_interface::{
    errors::AgentIntegrationError,
    host::AgentLogger,
    services::{AgentCatalog, AgentCatalogRequest, AgentSettings},
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

struct Logger;
impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {
        panic!("unexpected log");
    }
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {
        panic!("unexpected log");
    }
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {
        panic!("unexpected log");
    }
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {
        panic!("unexpected log");
    }
}

fn encoded(value: &impl serde::Serialize) -> Value {
    garcon_js::json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
}

#[tokio::test]
async fn descriptor_catalog_and_thinking_settings_match_the_original() {
    let oracle = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/descriptor-catalog.ts"
        ))
        .output()
        .await
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    let expected: Value = garcon_js::json::from_slice(&oracle.stdout).unwrap();
    let models = claude_catalog(Rc::new(Logger))
        .snapshot(AgentCatalogRequest {
            strict: true,
            signal: CancellationToken::new(),
            require_native_discovery: None,
            timeout_ms: None,
            dispatch_deadline: None,
        })
        .await
        .unwrap();
    let settings = claude_settings();
    let defaults = settings.defaults().unwrap();
    let patch = |mode: &str| IndexMap::from([("claudeThinkingMode".into(), json!(mode).into())]);
    let updated = settings
        .apply_patch(defaults.clone(), patch("off"))
        .unwrap();
    let error = settings
        .apply_patch(defaults.clone(), patch("invalid-mode"))
        .unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(encoded(&claude_descriptor()), expected["descriptor"]);
    assert_eq!(encoded(&models), expected["models"]);
    assert_eq!(encoded(&defaults), expected["defaults"]);
    assert_eq!(encoded(&settings.describe()), expected["settings"]);
    assert_eq!(encoded(&updated), expected["patched"]);
    assert_eq!(
        json!({"code":error.code.as_str(), "message":error.message}),
        expected["invalid"]
    );
}
