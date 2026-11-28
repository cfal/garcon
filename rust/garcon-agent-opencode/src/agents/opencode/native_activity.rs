//! Ports `server-agents/opencode/src/agents/opencode/native-activity.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_agents_common::native_session::path_native_session::PathNativeSessionCodec;
use garcon_interface::{
    host::AgentLogger,
    native_history::{AgentNativeActivity, AgentNativeActivityProbe, AgentNativeActivityResult},
    resources::ExecutorResult,
    transcript::AgentNativeSessionRef,
};
use garcon_js::SystemClock;
use tokio_util::sync::CancellationToken;

use super::{
    history_loader::{
        HistoryLoadOptions, fetch_open_code_stored_messages, latest_open_code_stored_activity_at,
    },
    opencode::OpenCodeRuntime,
};
use crate::js::AbortSignal;

const TAIL_MESSAGE_LIMIT: u64 = 20;

pub struct OpenCodeNativeActivity {
    pub runtime: Rc<OpenCodeRuntime>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub logger: Rc<dyn AgentLogger>,
}

#[async_trait(?Send)]
impl AgentNativeActivityProbe for OpenCodeNativeActivity {
    async fn last_activity(
        &self,
        native_session: AgentNativeSessionRef,
        signal: CancellationToken,
    ) -> ExecutorResult<AgentNativeActivityResult> {
        use AgentNativeActivityResult::{Ready, Unavailable};
        let signal = AbortSignal::from_token(signal);
        signal.throw_if_aborted()?;
        let Some(id) = self
            .native_sessions
            .decode(Some(&native_session))
            .ok()
            .and_then(|session| session.agent_session_id)
        else {
            return Ok(Unavailable);
        };
        let probe_signal = &signal;
        let activity = self
            .runtime
            .with_client_lease(
                |client| async move {
                    let messages = fetch_open_code_stored_messages(
                        Some(&id),
                        client.as_ref(),
                        &HistoryLoadOptions {
                            directory: None,
                            signal: probe_signal,
                            throw_on_error: true,
                            logger: self.logger.as_ref(),
                            limit: Some(TAIL_MESSAGE_LIMIT),
                        },
                    )
                    .await?;
                    Ok(latest_open_code_stored_activity_at(&messages, &SystemClock).await)
                },
                None,
            )
            .await;
        match activity {
            Ok(Some(last_entry_at)) => Ok(Ready {
                value: AgentNativeActivity {
                    last_entry_at: Some(last_entry_at),
                },
            }),
            Ok(None) => Ok(Unavailable),
            Err(_) => {
                signal.throw_if_aborted()?;
                Ok(Unavailable)
            }
        }
    }
}
