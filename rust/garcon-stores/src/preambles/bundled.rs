//! The built-ins from `server/controller/preambles/bundled.ts`.

use garcon_contract::preambles::PreambleDefinition;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct BundledPreambleDefinition {
    pub id: String,
    #[serde(flatten)]
    pub definition: PreambleDefinition,
}

pub(super) fn definitions() -> Result<Vec<BundledPreambleDefinition>, serde_json::Error> {
    garcon_js::json::from_str(include_str!("bundled.json"))
}
