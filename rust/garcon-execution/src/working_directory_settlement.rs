//! Settles a literal turn's reported directory under the shared chat mutation lock.

use std::{error::Error, rc::Rc, time::Duration};

use async_trait::async_trait;
use garcon_base::{
    errors::{ErrorInput, error_metadata},
    keyed_lock::KeyedLock,
};
use garcon_contract::{
    command_output::CommandWorkingDirectory, executors::effective_executor_id,
    project_resolution::ProjectResolution, ws_events::ChatProjectPathUpdatedPayload,
};
use garcon_interface::resources::ExecutorCallOptions;
use garcon_ledger::contracts::TranscriptViewId;
use tokio_util::sync::CancellationToken;

use crate::{
    turn_terminal_settlement::{
        TurnEventMetadata, WorkingDirectorySettlement, WorkingDirectorySettlementPort,
    },
    types::{ExecutionOperationResult, execution_error_input},
};

const INSPECT_TIMEOUT: Duration = Duration::from_secs(5);

pub struct WorkingDirectoryBinding {
    pub agent_id: String,
    pub executor_id: Option<String>,
    pub epoch: String,
    pub project_path: String,
}

#[async_trait(?Send)]
pub trait WorkingDirectoryPorts {
    fn get_chat(&self, chat_id: &str) -> Option<WorkingDirectoryBinding>;
    fn existing_view_id(&self, chat_id: &str)
    -> ExecutionOperationResult<Option<TranscriptViewId>>;
    async fn inspect(
        &self,
        path: &str,
        executor_id: &str,
        options: ExecutorCallOptions,
    ) -> ExecutionOperationResult<ProjectResolution>;
    async fn update_observed_path(
        &self,
        chat_id: &str,
        update: ChatProjectPathUpdatedPayload,
    ) -> ExecutionOperationResult<bool>;
    fn append_failure_notice(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        title: &str,
        content: &str,
    ) -> ExecutionOperationResult<()>;
}

pub struct WorkingDirectorySettler {
    ports: Rc<dyn WorkingDirectoryPorts>,
    lock: Rc<KeyedLock>,
}

impl WorkingDirectorySettler {
    pub fn new(ports: Rc<dyn WorkingDirectoryPorts>, lock: Rc<KeyedLock>) -> Self {
        Self { ports, lock }
    }

    async fn inspect(
        &self,
        path: &str,
        executor_id: &str,
    ) -> ExecutionOperationResult<ProjectResolution> {
        let signal = CancellationToken::new();
        let inspection = self.ports.inspect(
            path,
            executor_id,
            ExecutorCallOptions {
                signal: Some(signal.clone()),
                timeout_ms: Some(INSPECT_TIMEOUT.as_secs_f64() * 1000.0),
                dispatch_deadline: None,
            },
        );
        tokio::pin!(inspection);
        tokio::select! {
            resolution = &mut inspection => resolution,
            () = tokio::time::sleep(INSPECT_TIMEOUT) => {
                signal.cancel();
                inspection.await
            }
        }
    }
}

#[async_trait(?Send)]
impl WorkingDirectorySettlementPort for WorkingDirectorySettler {
    async fn settle(
        &self,
        chat_id: &str,
        turn: &TurnEventMetadata,
        is_current: &dyn Fn() -> bool,
    ) -> ExecutionOperationResult<WorkingDirectorySettlement> {
        let (Some(snapshot), Some(CommandWorkingDirectory::Reported { path })) =
            (&turn.execution_snapshot, &turn.working_directory)
        else {
            return Ok(WorkingDirectorySettlement::Settled);
        };
        let owned_binding =
            || -> ExecutionOperationResult<Option<(WorkingDirectoryBinding, TranscriptViewId)>> {
                let chat = self.ports.get_chat(chat_id);
                if !is_current() || snapshot.producer_lease.closed() {
                    return Ok(None);
                }
                let Some(chat) = chat.filter(|chat| {
                    chat.agent_id == snapshot.agent_id
                        && effective_executor_id(chat.executor_id.as_deref())
                            == snapshot.executor_id
                        && Some(chat.epoch.as_str()) == turn.agent_ownership_epoch.as_deref()
                }) else {
                    return Ok(None);
                };
                Ok(self
                    .ports
                    .existing_view_id(chat_id)?
                    .filter(|view_id| view_id.as_str() == snapshot.transcript_view_id)
                    .map(|view_id| (chat, view_id)))
            };
        let current =
            || -> ExecutionOperationResult<bool> {
                Ok(owned_binding()?
                    .is_some_and(|(chat, _)| chat.project_path == snapshot.project_path))
            };
        let settle_locked = || async {
            if !current()? {
                return Ok(WorkingDirectorySettlement::Settled);
            }
            let save = || async {
                let resolution = self.inspect(path, &snapshot.executor_id).await?;
                if !current()? {
                    return Ok(None);
                }
                match resolution {
                    ProjectResolution::Unavailable { reason } => Ok(Some(format!(
                        "Command completed, but its working directory is unavailable ({}).",
                        reason.as_str(),
                    ))),
                    ProjectResolution::Available {
                        effective_project_key,
                    } if effective_project_key != snapshot.project_path => {
                        let durable = self
                            .ports
                            .update_observed_path(
                                chat_id,
                                ChatProjectPathUpdatedPayload {
                                    chat_id: chat_id.into(),
                                    project_path: effective_project_key.clone(),
                                    effective_project_key,
                                    previous_project_path: snapshot.project_path.clone(),
                                },
                            )
                            .await?;
                        Ok((!durable).then(|| "Command completed, but its working directory save could not be confirmed.".into()))
                    }
                    ProjectResolution::Available { .. } => Ok(None),
                }
            };
            let result: ExecutionOperationResult<Option<String>> = save().await;
            let failure = match result {
                Ok(Some(failure)) => failure,
                Ok(None) => return Ok(WorkingDirectorySettlement::Settled),
                Err(error) => {
                    if !current()? {
                        return Ok(WorkingDirectorySettlement::Settled);
                    }
                    format!(
                        "Command completed, but its working directory could not be synchronized: {}",
                        js_error_string(error.as_ref())
                    )
                }
            };
            // An uncertain save can publish its candidate path without changing the owner or view.
            if let Some((_, view_id)) = owned_binding()? {
                self.ports.append_failure_notice(
                    chat_id,
                    &view_id,
                    "Working directory not saved",
                    &failure,
                )?;
            }
            Ok(WorkingDirectorySettlement::Failed { message: failure })
        };
        self.lock
            .run_exclusive(&format!("chat:{chat_id}"), settle_locked, None)
            .await?
    }
}

fn js_error_string(error: &(dyn Error + 'static)) -> String {
    let name = match execution_error_input(error) {
        ErrorInput::Diagnostic(error) => error.diagnostic_metadata().name,
        _ => error_metadata(error).name,
    };
    let message = error.to_string();
    if message.is_empty() {
        name.into()
    } else {
        format!("{name}: {message}")
    }
}

#[cfg(test)]
mod tests;
