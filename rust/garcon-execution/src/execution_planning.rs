//! Projects the executor's validated credential reference into its launch selection.

use garcon_contract::agent_execution::{
    AgentCredentialReference, AgentCredentialReferenceKind, AgentEndpointSelection,
};
use garcon_stores::api_providers::endpoint_resolver::{
    ApiProviderEndpointResolver, ResolvedModelSelection,
};

use crate::types::ExecutionOperationResult;

pub fn to_agent_endpoint_selection(
    resolver: &ApiProviderEndpointResolver,
    selection: &ResolvedModelSelection,
) -> ExecutionOperationResult<Option<AgentEndpointSelection>> {
    let reference = resolver.resolve_endpoint_reference(selection)?;
    let (Some(reference), Some(api_provider_id), Some(endpoint_id), Some(protocol)) = (
        reference,
        selection
            .api_provider_id
            .as_ref()
            .filter(|id| !id.is_empty()),
        selection.endpoint_id.as_ref().filter(|id| !id.is_empty()),
        selection.protocol,
    ) else {
        return Ok(None);
    };
    if let Some(endpoint) = &selection.endpoint {
        return Ok(Some(endpoint.clone()));
    }
    let provider_label = if reference.api_provider.label.is_empty() {
        api_provider_id.clone()
    } else {
        reference.api_provider.label
    };
    Ok(Some(AgentEndpointSelection {
        api_provider_id: api_provider_id.clone(),
        endpoint_id: endpoint_id.clone(),
        provider_label,
        protocol,
        base_url: reference.endpoint.base_url,
        model: selection.model.clone(),
        is_local: selection.is_local,
        capabilities: reference.endpoint.capabilities,
        headers: reference.endpoint.headers.unwrap_or_default(),
        credential: Some(AgentCredentialReference {
            kind: AgentCredentialReferenceKind::ApiProviderEndpoint,
            api_provider_id: api_provider_id.clone(),
            endpoint_id: endpoint_id.clone(),
            revision: reference.api_provider.revision,
        }),
    }))
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use garcon_base::{domain_error::as_domain_error, errors::ErrorInput};
    use garcon_cases::{CaseError, replay, text};
    use garcon_contract::api_providers::ApiProtocol;
    use garcon_js::SystemClock;
    use garcon_stores::api_providers::{
        access::ApiProviderAccess, assignments::ApiProviderAssignmentStore,
        endpoint_resolver::ModelSelectionInput, store::ApiProviderStore,
    };
    use serde_json::json;

    use super::*;

    async fn fixture() -> (tempfile::TempDir, ApiProviderEndpointResolver) {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        tokio::fs::write(
            root.path().join("api-providers.json"),
            include_bytes!(
                "../../garcon-stores/tests/fixtures/api-provider-endpoint-resolver.json"
            ),
        )
        .await
        .unwrap();
        tokio::fs::write(
            root.path().join("api-provider-assignments.json"),
            r#"{"version":1,"revision":0,"assignments":{"local":["acme"]}}"#,
        )
        .await
        .unwrap();
        let store = ApiProviderStore::open(directory, Rc::new(SystemClock))
            .await
            .unwrap();
        let assignments = ApiProviderAssignmentStore::open(directory).await.unwrap();
        let resolver = ApiProviderEndpointResolver::new(
            ApiProviderAccess::new(store, assignments, Rc::new(|id| id == "local")),
            Rc::new(|_, _| vec![ApiProtocol::OpenAiCompatible]),
        );
        (root, resolver)
    }

    #[tokio::test]
    async fn projects_endpoints_with_the_same_revision_and_wire_shape() {
        let (_root, resolver) = fixture().await;
        replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/execution-planning"
            ),
            |name, args| {
                if name != "endpointProjectionTrace" {
                    return Err(CaseError::unhandled(name));
                }
                let scenario = text(name, args.first())?
                    .ok_or_else(|| CaseError::undeliverable("missing endpoint scenario"))?;
                let mut selection = resolver
                    .resolve_selection(ModelSelectionInput {
                        executor_id: None,
                        agent_id: Some("test"),
                        model: "acme-code",
                        api_provider_id: (scenario != "native").then_some("acme"),
                        model_endpoint_id: (scenario != "native").then_some("acme_openai"),
                    })
                    .unwrap();
                match scenario {
                    "native" | "resolved" => {}
                    "metadata-only" => selection.endpoint = None,
                    "missing-protocol" => selection.protocol = None,
                    "stale" => {
                        selection
                            .endpoint
                            .as_mut()
                            .unwrap()
                            .credential
                            .as_mut()
                            .unwrap()
                            .revision -= 1
                    }
                    "wrong-executor" => selection.executor_id = Some("not-configured".into()),
                    _ => return Err(CaseError::undeliverable("unknown endpoint scenario")),
                }
                Ok(match to_agent_endpoint_selection(&resolver, &selection) {
                    Ok(endpoint) => {
                        json!({"wire": serde_json::to_string(&endpoint).unwrap(), "error":null, "code":null})
                    }
                    Err(error) => {
                        json!({"wire":null, "error":error.to_string(), "code":as_domain_error(error.as_ref()).map(|domain| domain.code.as_str())})
                    }
                })
            },
        );
    }

    #[tokio::test]
    async fn keeps_the_model_selection_error_diagnostic_after_erasure() {
        let (_root, resolver) = fixture().await;
        let error = resolver
            .resolve_selection(ModelSelectionInput {
                executor_id: None,
                agent_id: None,
                model: "acme-code",
                api_provider_id: Some("acme"),
                model_endpoint_id: Some("acme_openai"),
            })
            .unwrap_err();
        let ErrorInput::Diagnostic(diagnostic) =
            crate::types::execution_error_input(error.as_ref())
        else {
            panic!("missing model selection diagnostic");
        };
        assert_eq!(diagnostic.diagnostic_metadata().name, "ModelSelectionError");
        assert_eq!(
            diagnostic.diagnostic_metadata().code,
            Some("SELECTION_INCOMPLETE")
        );
    }
}
