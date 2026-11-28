use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode};

pub fn unavailable_service(service: &str) -> AgentCallError {
    AgentCallError::with_code(
        AgentDeliveryOutcome::NotDispatched,
        format!("Executor {service} service is unavailable"),
        AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_unavailable_service_without_claiming_dispatch() {
        let error = unavailable_service("files");
        assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
        assert_eq!(error.to_string(), "Executor files service is unavailable");
        assert_eq!(error.code, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED);
    }
}
