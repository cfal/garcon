//! Replays cases from `server-agents/common/src/environment/executable-override.ts`.

use garcon_agents_common::environment::executable_override::resolve_executable_override;
use garcon_cases::{CaseError, replay, round_tripped, text};
use serde_json::{Value, json};

#[test]
fn recorded_executable_override_matches() {
    // The recording resolves relative commands against the root directory on Linux.
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/executable-override"
        ),
        |function, args| {
            if function != "resolveExecutableOverride" {
                return Err(CaseError::unhandled(function));
            }
            let command = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("expected a command"))?;
            let platform = round_tripped(function, args.get(1))?;
            let platform = match platform.as_deref() {
                Some(Value::String(platform)) => Some(platform.as_str()),
                _ => Some("linux"),
            };
            Ok(json!(resolve_executable_override(command, platform, "/")))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
