//! Ports common/model-catalog.ts.

use serde::{Deserialize, Serialize};

use crate::agents::AgentCatalog;

pub const CATALOG_INSTANCE_HEADER: &str = "X-Garcon-Executor-Instance";
pub const LOGIN_AGENT_QUERY: &str = "loginAgent";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCatalogResponse {
    pub catalog: AgentCatalog,
}
