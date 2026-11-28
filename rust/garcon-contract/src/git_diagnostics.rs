//! Ports `common/git-diagnostics.ts`.

use garcon_js::Number;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

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
    pub duration_ms: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewRouteMetrics {
    pub phases: Vec<GitReviewRoutePhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hits: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_count: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bisection_count: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandDiagnostics {
    pub command: String,
    pub duration_ms: Number,
    pub stdout_bytes: Number,
    pub stderr_bytes: Number,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GitOperationDiagnostics {
    #[serde(flatten)]
    pub metrics: GitReviewRouteMetrics,
    pub commands: Vec<GitCommandDiagnostics>,
}

impl Serialize for GitOperationDiagnostics {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // The runtime assigns cache and batch counts before final file and row totals.
        let metrics = &self.metrics;
        let optional = [
            ("cacheHits", metrics.cache_hits),
            ("batchCount", metrics.batch_count),
            ("bisectionCount", metrics.bisection_count),
            ("fileCount", metrics.file_count),
            ("rowCount", metrics.row_count),
        ];
        let present = optional.iter().filter(|(_, value)| value.is_some()).count();
        let mut state = serializer.serialize_struct("GitOperationDiagnostics", 2 + present)?;
        state.serialize_field("phases", &metrics.phases)?;
        for (key, value) in optional {
            if let Some(value) = value {
                state.serialize_field(key, &value)?;
            }
        }
        state.serialize_field("commands", &self.commands)?;
        state.end()
    }
}
