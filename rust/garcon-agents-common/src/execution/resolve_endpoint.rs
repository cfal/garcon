//! Ports `server-agents/common/src/execution/resolve-endpoint.ts`.

use garcon_base::executor_disconnect::ExecutorSessionLostError;
use garcon_contract::agent_execution::AgentEndpointSelection;
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode},
    host::{AgentApiProviderReader, AgentResolveCredentialRequest},
    resources::ExecutorResult,
};
use tokio_util::sync::CancellationToken;

use super::admission::check_signal;

// The credential must not enter diagnostics through a derived Debug implementation.
pub struct ResolvedAgentEndpoint {
    pub selection: AgentEndpointSelection,
    pub credential: Option<String>,
}

pub async fn resolve_agent_endpoint(
    api_providers: &dyn AgentApiProviderReader,
    selection: Option<AgentEndpointSelection>,
    signal: &CancellationToken,
) -> ExecutorResult<Option<ResolvedAgentEndpoint>> {
    check_signal(Some(signal))?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let Some(reference) = selection.credential.clone() else {
        return Ok(Some(ResolvedAgentEndpoint {
            selection,
            credential: None,
        }));
    };
    let credential = match api_providers
        .resolve_credential(AgentResolveCredentialRequest {
            reference,
            signal: signal.clone(),
        })
        .await
    {
        Ok(credential) => credential,
        Err(error)
            if call_error(error.as_ref())
                .is_some_and(|error| error.outcome != AgentDeliveryOutcome::Rejected) =>
        {
            check_signal(Some(signal))?;
            return Err(AgentCallError::new(
                AgentDeliveryOutcome::Rejected,
                "Provider credential could not be read from the controller. Try again.",
            )
            .into());
        }
        Err(error) => return Err(error),
    };
    check_signal(Some(signal))?;
    let credential = credential.ok_or_else(|| {
        AgentCallError::with_code(
            AgentDeliveryOutcome::Rejected,
            "Provider credential is unavailable",
            AgentIntegrationErrorCode::API_PROVIDER_UNAVAILABLE,
        )
    })?;
    Ok(Some(ResolvedAgentEndpoint {
        selection,
        credential: Some(credential.value),
    }))
}

pub(super) fn call_error<'a>(
    error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a AgentCallError> {
    error.downcast_ref::<AgentCallError>().or_else(|| {
        error
            .downcast_ref::<ExecutorSessionLostError>()
            .map(|lost| &**lost)
    })
}

#[cfg(test)]
mod tests;
