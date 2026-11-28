//! Ports `common/git-diagnostics.ts`.

use garcon_js::Number;
use serde::{Deserialize, Deserializer, Serialize};

fn number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Number, D::Error> {
    f64::deserialize(deserializer).map(Number)
}

fn optional_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Number>, D::Error> {
    Option::<f64>::deserialize(deserializer).map(|value| value.map(Number))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitReviewRoutePhaseName {
    Resolve,
    SummaryGit,
    DocumentRegister,
    FreshnessBefore,
    BodyCache,
    BodyGit,
    BodySplit,
    PatchScan,
    FreshnessAfter,
    Serialize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewRoutePhase {
    pub name: GitReviewRoutePhaseName,
    #[serde(deserialize_with = "number")]
    pub duration_ms: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewRouteMetrics {
    pub phases: Vec<GitReviewRoutePhase>,
    #[serde(
        default,
        deserialize_with = "optional_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub file_count: Option<Number>,
    #[serde(
        default,
        deserialize_with = "optional_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub row_count: Option<Number>,
    #[serde(
        default,
        deserialize_with = "optional_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_hits: Option<Number>,
    #[serde(
        default,
        deserialize_with = "optional_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub batch_count: Option<Number>,
    #[serde(
        default,
        deserialize_with = "optional_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub bisection_count: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandDiagnostics {
    pub command: String,
    #[serde(deserialize_with = "number")]
    pub duration_ms: Number,
    #[serde(deserialize_with = "number")]
    pub stdout_bytes: Number,
    #[serde(deserialize_with = "number")]
    pub stderr_bytes: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitOperationDiagnostics {
    #[serde(flatten)]
    pub metrics: GitReviewRouteMetrics,
    pub commands: Vec<GitCommandDiagnostics>,
}
