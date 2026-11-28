use std::rc::Rc;

use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    host::AgentLogger, native_message_source::NativeSourced, resources::ExecutorResult,
};
use tokio_util::sync::CancellationToken;

use crate::{
    app_server::{
        client::CodexAppServerClient, paginated_history_source::PaginatedCodexHistorySource,
    },
    history_loader::load_codex_chat_messages,
    history_profile::{
        CodexHistoryProfile, CodexSessionIdentityInput, inspect_codex_history_profile,
    },
};

pub struct CodexHistoryService {
    pub create_client: Rc<dyn Fn() -> CodexAppServerClient>,
    pub logger: Rc<dyn AgentLogger>,
}

impl CodexHistoryService {
    pub async fn inspect(
        &self,
        native_path: Option<&str>,
        thread_id: Option<&str>,
        signal: &CancellationToken,
    ) -> ExecutorResult<Option<CodexHistoryProfile>> {
        let Some(native_path) = native_path.filter(|path| !path.is_empty()) else {
            return Ok(None);
        };
        inspect_codex_history_profile(CodexSessionIdentityInput {
            native_path,
            expected_thread_id: thread_id,
            signal,
        })
        .await
        .map(Some)
    }

    pub async fn load(
        &self,
        native_path: Option<&str>,
        thread_id: Option<&str>,
        signal: &CancellationToken,
    ) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
        match self.inspect(native_path, thread_id, signal).await? {
            None => Ok(Vec::new()),
            Some(CodexHistoryProfile::Legacy { native_path, .. }) => {
                load_codex_chat_messages(
                    Some(&native_path),
                    self.logger.as_ref(),
                    true,
                    Some(signal),
                )
                .await
            }
            Some(CodexHistoryProfile::Paginated {
                native_path,
                identity,
                ..
            }) => {
                PaginatedCodexHistorySource {
                    native_path,
                    thread_id: identity.thread_id,
                    created_at: identity.created_at,
                    create_client: self.create_client.clone(),
                }
                .load(signal)
                .await
            }
        }
    }
}
