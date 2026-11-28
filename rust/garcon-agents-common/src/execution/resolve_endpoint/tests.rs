use std::cell::Cell;

use async_trait::async_trait;
use garcon_base::errors::{ErrorInput, diagnostic_error_code};
use garcon_interface::host::AgentResolvedCredential;
use tokio_util::sync::CancellationToken;

use super::*;

struct Reader<F> {
    calls: Cell<usize>,
    resolve: F,
}

#[async_trait(?Send)]
impl<F> AgentApiProviderReader for Reader<F>
where
    F: Fn(AgentResolveCredentialRequest) -> ExecutorResult<Option<AgentResolvedCredential>>,
{
    async fn resolve_credential(
        &self,
        request: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>> {
        self.calls.update(|n| n + 1);
        assert_eq!(request.reference.revision, 1);
        assert_eq!(request.reference.endpoint_id, "endpoint");
        (self.resolve)(request)
    }
}

fn endpoint() -> AgentEndpointSelection {
    garcon_js::json::from_str(r#"{
        "apiProviderId":"provider","endpointId":"endpoint","providerLabel":"Provider","protocol":"openai-compatible",
        "baseUrl":"https://example.test","model":"model","isLocal":false,"capabilities":{"chatCompletions":false,"responses":true},
        "headers":{},"credential":{"kind":"api-provider-endpoint","revision":1,"apiProviderId":"provider","endpointId":"endpoint"}
    }"#).unwrap()
}

#[tokio::test]
async fn distinguishes_an_explicit_key_from_denied_credential_resolution() {
    for value in [Some("synthetic"), Some(""), None] {
        let reader = Reader {
            calls: Cell::new(0),
            resolve: |_| {
                Ok(value.map(|value| AgentResolvedCredential {
                    kind: "token".into(),
                    value: value.into(),
                }))
            },
        };
        let selection = endpoint();
        let result =
            resolve_agent_endpoint(&reader, Some(selection.clone()), &CancellationToken::new())
                .await;
        if let Some(value) = value {
            let resolved = result.unwrap().unwrap();
            assert_eq!(resolved.selection, selection);
            assert_eq!(resolved.credential.as_deref(), Some(value));
        } else {
            let error = result.err().unwrap();
            assert_eq!(
                error.downcast_ref::<AgentCallError>().unwrap().code,
                AgentIntegrationErrorCode::API_PROVIDER_UNAVAILABLE
            );
        }
        assert_eq!(reader.calls.get(), 1);
    }
}

#[tokio::test]
async fn fails_definitely_when_the_read_was_not_dispatched_or_left_unknown() {
    for outcome in [
        AgentDeliveryOutcome::NotDispatched,
        AgentDeliveryOutcome::Unknown,
        AgentDeliveryOutcome::Rejected,
    ] {
        let reader = Reader {
            calls: Cell::new(0),
            resolve: |_| Err(AgentCallError::new(outcome, "Synthetic credential failure").into()),
        };
        let error = resolve_agent_endpoint(&reader, Some(endpoint()), &CancellationToken::new())
            .await
            .err()
            .unwrap();
        let error = error.downcast_ref::<AgentCallError>().unwrap();
        assert_eq!(error.outcome, AgentDeliveryOutcome::Rejected);
        assert_eq!(error.code, AgentIntegrationErrorCode::UNAVAILABLE);
        assert_eq!(
            error.message,
            if outcome == AgentDeliveryOutcome::Rejected {
                "Synthetic credential failure"
            } else {
                "Provider credential could not be read from the controller. Try again."
            }
        );
    }
}

#[tokio::test]
async fn detects_cancellation_before_acquisition_and_after_an_uncertain_credential_read() {
    let reader = Reader {
        calls: Cell::new(0),
        resolve: |request: AgentResolveCredentialRequest| {
            request.signal.cancel();
            Err(ExecutorSessionLostError::new(
                AgentDeliveryOutcome::Unknown,
                "Synthetic lost session",
            )
            .into())
        },
    };
    let signal = CancellationToken::new();
    let mut keyless = endpoint();
    keyless.credential.take();
    assert!(
        resolve_agent_endpoint(&reader, Some(keyless), &signal)
            .await
            .unwrap()
            .unwrap()
            .credential
            .is_none()
    );
    assert!(
        resolve_agent_endpoint(&reader, None, &signal)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(reader.calls.get(), 0);
    for _ in 0..2 {
        let error = resolve_agent_endpoint(&reader, Some(endpoint()), &signal)
            .await
            .err()
            .unwrap();
        assert_eq!(
            diagnostic_error_code(ErrorInput::Error(error.as_ref())),
            "AbortError"
        );
        assert_eq!(error.to_string(), "The operation was aborted.");
    }
    assert_eq!(reader.calls.get(), 1);
}
