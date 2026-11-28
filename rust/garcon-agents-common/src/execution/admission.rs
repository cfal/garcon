//! Ports `server-agents/common/src/execution/admission.ts`.

use garcon_base::errors::NamedError;
use garcon_interface::{
    execution::AgentExecutionAdmission,
    resources::{ExecutorCallOptions, ExecutorResult},
};
use tokio_util::sync::CancellationToken;

pub fn assert_execution_open(admission: &dyn AgentExecutionAdmission) -> ExecutorResult<()> {
    check_signal(Some(admission.signal()))
}

pub async fn mark_execution_started(admission: &dyn AgentExecutionAdmission) -> ExecutorResult<()> {
    assert_execution_open(admission)?;
    admission.mark_started().await
}

pub(crate) fn check_signal(signal: Option<&CancellationToken>) -> ExecutorResult<()> {
    if signal.is_some_and(CancellationToken::is_cancelled) {
        return Err(NamedError {
            name: "AbortError".to_owned(),
            message: "The operation was aborted.".to_owned(),
            code: None,
        }
        .into());
    }
    Ok(())
}

pub(super) fn check_options(options: Option<&ExecutorCallOptions>) -> ExecutorResult<()> {
    check_signal(options.and_then(|options| options.signal.as_ref()))
}
