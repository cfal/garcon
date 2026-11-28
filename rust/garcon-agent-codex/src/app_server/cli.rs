use std::sync::LazyLock;

use regress::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCodexCli {
    pub command: String,
    pub source: CodexCommandSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexCommandSource {
    Env,
    Path,
}

pub const CODEX_CLI_NOT_FOUND: &str = "Codex CLI was not found on this executor. Put Codex on the service PATH or set GARCON_CODEX_CLI to its executable (codex.exe on Windows).";

#[derive(Debug, thiserror::Error)]
#[error(
    "Codex app-server requires Codex CLI 0.171.0 or newer. Upgrade it on this executor or set GARCON_CODEX_CLI."
)]
pub struct IncompatibleCodex;

pub fn assert_compatible_codex(user_agent: &str) -> Result<(), IncompatibleCodex> {
    static VERSION: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^[^\s/]+/(\d+)\.(\d+)\.\d+(?:[-+\s]|$)").expect("Codex version pattern")
    });
    let version = VERSION.find(user_agent).ok_or(IncompatibleCodex)?;
    let major = user_agent[version.group(1).ok_or(IncompatibleCodex)?]
        .parse::<f64>()
        .unwrap_or(f64::INFINITY);
    let minor = user_agent[version.group(2).ok_or(IncompatibleCodex)?]
        .parse::<f64>()
        .unwrap_or(f64::INFINITY);
    if major == 0.0 && minor < 171.0 {
        Err(IncompatibleCodex)
    } else {
        Ok(())
    }
}
