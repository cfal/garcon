//! Ports `server-agents/common/src/acp/policy.ts`.

use super::errors::AcpRpcError;
use super::protocol::AcpSessionPromptResult;

pub trait AcpSteeringProtocol {
    fn likely_superseded(&self, result: &AcpSessionPromptResult) -> bool;
    fn refused(&self, error: &AcpRpcError) -> bool;
}
