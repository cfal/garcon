//! Ports `server-agents/pi/src/agents/pi/pi-auth.ts`.

use garcon_base::errors::error_metadata;
use garcon_contract::agent_execution::{AgentAuthSource, AgentAuthStatus};
use garcon_interface::resources::ExecutorResult;
use tokio_util::sync::CancellationToken;

use crate::pi_models::{PiModelCatalogService, check_abort};

pub async fn get_pi_auth_status(
    models: &PiModelCatalogService,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<AgentAuthStatus> {
    let (authenticated, label) = match models.get_models_strict(signal).await {
        Ok(models) => (!models.is_empty(), String::new()),
        Err(error) => {
            if let Some(signal) = signal {
                check_abort(signal)?;
            }
            if error_metadata(error.as_ref()).name == "AbortError" {
                return Err(error);
            }
            (false, error.to_string())
        }
    };
    Ok(AgentAuthStatus {
        authenticated,
        label,
        can_reauth: false,
        source: if authenticated {
            AgentAuthSource::Cli
        } else {
            AgentAuthSource::None
        },
        detail: None,
    })
}
