use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunningStatus {
    Running,
    Interrupting,
    Completing,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishSessionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_message: Option<String>,
    #[serde(default)]
    pub aborted: bool,
    #[serde(default)]
    pub emit_finished_on_abort: bool,
}
