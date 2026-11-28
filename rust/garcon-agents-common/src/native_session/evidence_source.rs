//! Ports `server-agents/common/src/native-session/evidence-source.ts`.

use async_trait::async_trait;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::native_history::{AgentHistoryImportRequest, AgentNativeSessionAccess};
use garcon_interface::native_message_source::NativeSourced;
use garcon_interface::resources::ExecutorResult;

/// A chat whose native evidence is read, and the signal that stops the read.
pub type AgentNativeEvidenceRequest = AgentHistoryImportRequest;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentNativeEvidenceSnapshot {
    pub messages: Vec<NativeSourced<ChatMessage>>,
}

/// Keeps provider-native reads behind the integration boundary. Core uses the
/// ledger for serving and reaches native evidence only through explicit flows.
#[async_trait(?Send)]
pub trait AgentNativeEvidenceSource: AgentNativeSessionAccess {
    async fn load(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot>;
}
