use garcon_base::errors::error_metadata;
use garcon_cases::{CaseError, markers, replay};
use garcon_js::SystemClock;
use serde_json::{Value, json};
use tokio::{fs, task::LocalSet};

use super::*;
use crate::api_providers::assignments::{ApiProviderAssignmentStore, RetainExecutorReferences};
use crate::api_providers::store::{
    ApiProviderStore, UpdateApiProviderEndpointInput, UpdateApiProviderInput,
};

const REMOTE: &str = "11111111-1111-4111-8111-111111111111";

struct Fixture {
    resolver: ApiProviderEndpointResolver,
    access: Rc<ApiProviderAccess>,
    _root: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().to_str().unwrap();
    fs::write(
        root.path().join("api-providers.json"),
        include_bytes!("../../tests/fixtures/api-provider-endpoint-resolver.json"),
    )
    .await
    .unwrap();
    fs::write(
        root.path().join("api-provider-assignments.json"),
        json!({"version":1,"revision":0,"assignments":{
            "local":["acme"], (REMOTE):["acme","remote_only"]
        }})
        .to_string(),
    )
    .await
    .unwrap();
    let store = ApiProviderStore::open(directory, Rc::new(SystemClock))
        .await
        .unwrap();
    let assignments = ApiProviderAssignmentStore::open(directory).await.unwrap();
    let access = ApiProviderAccess::new(
        store,
        assignments,
        Rc::new(|id| matches!(id, "local" | REMOTE)),
    );
    let resolver = ApiProviderEndpointResolver::new(
        access.clone(),
        Rc::new(|agent, executor| {
            if executor == REMOTE || matches!(agent, "claude" | "direct-anthropic-compatible") {
                vec![ApiProtocol::AnthropicMessages]
            } else if matches!(
                agent,
                "codex" | "direct-openai-compatible" | "direct-openai-responses-compatible"
            ) {
                vec![ApiProtocol::OpenAiCompatible]
            } else {
                Vec::new()
            }
        }),
    );
    Fixture {
        resolver,
        access,
        _root: root,
    }
}

fn selection_input<'a>(
    agent: &'a str,
    executor: Option<&'a str>,
    model: &'a str,
    provider: &'a str,
    endpoint: &'a str,
) -> ModelSelectionInput<'a> {
    ModelSelectionInput {
        executor_id: executor,
        agent_id: Some(agent),
        model,
        api_provider_id: Some(provider),
        model_endpoint_id: Some(endpoint),
    }
}

fn domain_code(error: Result<impl Sized>) -> ErrorCode {
    let error = error.err().unwrap();
    as_domain_error(error.as_ref()).unwrap().code
}

#[tokio::test]
async fn uses_endpoint_scoped_options_and_resolves_raw_models_for_both_protocols() {
    let Fixture { resolver, .. } = fixture().await;
    for (agent, endpoint_name, raw, protocol, supports_images) in [
        (
            "direct-openai-compatible",
            "acme_openai",
            "acme-code",
            ApiProtocol::OpenAiCompatible,
            false,
        ),
        (
            "direct-anthropic-compatible",
            "acme_anthropic",
            "acme-claude",
            ApiProtocol::AnthropicMessages,
            true,
        ),
    ] {
        let options = resolver.get_model_options(agent, None).unwrap();
        assert_eq!(options.len(), 2);
        let first = &options[0];
        assert_eq!(first.value, format!("{endpoint_name}:{raw}"));
        assert_eq!(first.api_provider_id.as_deref(), Some("acme"));
        assert_eq!(first.endpoint_id.as_deref(), Some(endpoint_name));
        assert_eq!(first.raw_model.as_deref(), Some(raw));
        assert_eq!(first.protocol, Some(protocol));
        assert_eq!(first.supports_images, Some(supports_images));
        let selection = resolver
            .resolve_selection(selection_input(
                agent,
                None,
                &first.value,
                "acme",
                endpoint_name,
            ))
            .unwrap();
        assert_eq!(selection.model, raw);
        assert!(!selection.is_local);
        assert_eq!(
            resolver
                .resolve_endpoint_reference(&selection)
                .unwrap()
                .unwrap()
                .endpoint
                .id,
            endpoint_name
        );
    }
    assert_eq!(
        resolver
            .get_model_options("direct-openai-responses-compatible", None)
            .unwrap()
            .len(),
        2
    );
    let remote = resolver.get_model_options("codex", Some(REMOTE)).unwrap();
    assert_eq!(remote.len(), 3);
    assert_eq!(remote[2].value, "remote_anthropic:llama:latest");
    assert_eq!(remote[2].supports_images, Some(true));
    assert_eq!(remote[2].label, "Remote: Raw alias");
    assert_eq!(
        domain_code(resolver.get_model_options("codex", Some("not-configured"))),
        ErrorCode::EXECUTOR_NOT_FOUND
    );
}

#[tokio::test]
async fn blank_keys_stay_reference_only_and_protocol_errors_keep_their_class() {
    let Fixture { resolver, .. } = fixture().await;
    for (agent, endpoint_name) in [
        ("codex", "acme_openai_blank"),
        ("claude", "acme_anthropic_blank"),
    ] {
        let selected = format!("{endpoint_name}:llama3");
        let selection = resolver
            .resolve_selection(selection_input(
                agent,
                None,
                &selected,
                "acme",
                endpoint_name,
            ))
            .unwrap();
        assert!(selection.is_local);
        assert_eq!(selection.model, "llama3");
        let endpoint = serde_json::to_value(&selection.endpoint).unwrap();
        assert_eq!(endpoint["credential"]["revision"], 3);
        assert!(endpoint.get("apiKey").is_none());
        assert!(endpoint.get("env").is_none());
        assert_eq!(endpoint["headers"], json!({}));
    }
    for agent in ["claude", "direct-anthropic-compatible"] {
        let error = resolver
            .resolve_selection(selection_input(
                agent,
                None,
                "acme-code",
                "acme",
                "acme_openai",
            ))
            .err()
            .unwrap();
        let typed = error.downcast_ref::<ModelSelectionError>().unwrap();
        assert_eq!(typed.code, ModelSelectionErrorCode::EndpointNotExposed);
        assert_eq!(typed.diagnostic_metadata().name, "ModelSelectionError");
    }
}

#[tokio::test]
async fn reference_resolution_rechecks_assignment_revision_and_historical_classification() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                resolver,
                access,
                _root,
            } = fixture().await;
            let input = selection_input(
                "codex",
                Some(REMOTE),
                "option",
                "remote_only",
                "remote_anthropic",
            );
            let captured = resolver.resolve_selection(input).unwrap();
            assert_eq!(captured.model, "llama:latest");
            assert_eq!(
                resolver
                    .resolve_endpoint_reference(&captured)
                    .unwrap()
                    .unwrap()
                    .api_provider
                    .revision,
                1
            );
            let mut missing_credential = captured.clone();
            missing_credential.endpoint.as_mut().unwrap().credential = None;
            assert_eq!(
                domain_code(resolver.resolve_endpoint_reference(&missing_credential)),
                ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED
            );
            let mut metadata_only = captured.clone();
            metadata_only.endpoint = None;
            assert!(
                resolver
                    .resolve_endpoint_reference(&metadata_only)
                    .unwrap()
                    .is_some()
            );
            access
                .store
                .update_api_provider(
                    "remote_only".into(),
                    UpdateApiProviderInput {
                        revision: Some(1),
                        endpoint: Some(UpdateApiProviderEndpointInput {
                            api_key: Some("NewSyntheticKey".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                domain_code(resolver.resolve_endpoint_reference(&captured)),
                ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED
            );
            assert_eq!(
                resolver
                    .resolve_endpoint_reference(&metadata_only)
                    .unwrap()
                    .unwrap()
                    .api_provider
                    .revision,
                2
            );
            let fresh = resolver.resolve_selection(input).unwrap();
            let retain: RetainExecutorReferences = Rc::new(|next, current| {
                assert_eq!(next, [Some(REMOTE)]);
                assert!(current.is_empty());
                Ok(Box::new(|| {}))
            });
            access
                .unassign(REMOTE.into(), "remote_only".into(), retain, None)
                .await
                .unwrap();
            assert_eq!(
                domain_code(resolver.resolve_endpoint_reference(&fresh)),
                ErrorCode::API_PROVIDER_UNAVAILABLE
            );
            let historic = resolver
                .describe_previous(PreviousModelSelectionInput {
                    model: "remote_anthropic:llama:latest",
                    api_provider_id: Some("remote_only"),
                    model_endpoint_id: Some("remote_anthropic"),
                })
                .unwrap();
            assert!(historic.is_local);
            assert!(historic.executor_id.is_none());
            assert_eq!(historic.model, "remote_anthropic:llama:latest");
            assert!(
                assert_same_api_provider_boundary(
                    &historic,
                    &ResolvedModelSelection::native("native")
                )
                .is_err()
            );
        })
        .await;
}

fn case_error(error: Box<dyn std::error::Error>) -> CaseError {
    if let Some(error) = error.downcast_ref::<ModelSelectionError>() {
        let metadata = error.diagnostic_metadata();
        return CaseError::new(metadata.name, &error.message)
            .with_property("code", error.code.as_str());
    }
    let mut outcome = CaseError::new(error_metadata(error.as_ref()).name, error.to_string());
    if let Some(domain) = as_domain_error(error.as_ref()) {
        outcome = outcome
            .with_property("code", domain.code.as_str())
            .with_property("status", domain.status)
            .with_property("retryable", domain.retryable);
    }
    outcome
}

#[tokio::test]
async fn resolves_the_recorded_original_cases() {
    let owner = fixture().await;
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/api-provider-endpoint-resolver"
        ),
        |function, args| {
            if function == "assertSameApiProviderBoundary" {
                let selection = |index| {
                    let local = args
                        .get(index)
                        .and_then(Value::as_bool)
                        .ok_or_else(|| CaseError::undeliverable("expected locality flag"))?;
                    let mut selection = ResolvedModelSelection::native("fixture");
                    selection.is_local = local;
                    Ok(selection)
                };
                return assert_same_api_provider_boundary(&selection(0)?, &selection(1)?)
                    .map(|()| markers::undefined())
                    .map_err(case_error);
            }
            let body = args
                .first()
                .ok_or_else(|| CaseError::undeliverable("expected selection input"))?;
            let model = body["model"]
                .as_str()
                .ok_or_else(|| CaseError::undeliverable("expected model string"))?;
            let input = ModelSelectionInput {
                executor_id: body["executorId"].as_str(),
                agent_id: body["agentId"].as_str(),
                model,
                api_provider_id: body["apiProviderId"].as_str(),
                model_endpoint_id: body["modelEndpointId"].as_str(),
            };
            let resolver = &owner.resolver;
            let result = match function {
                "resolveSelection" => resolver
                    .resolve_selection(input)
                    .map(|selection| json!(selection)),
                "describePrevious" => resolver
                    .describe_previous(PreviousModelSelectionInput {
                        model: input.model,
                        api_provider_id: input.api_provider_id,
                        model_endpoint_id: input.model_endpoint_id,
                    })
                    .map(|selection| json!(selection)),
                "modelSupportsImages" => resolver
                    .model_supports_images(input)
                    .map(|supported| json!(supported)),
                _ => return Err(CaseError::unhandled(function)),
            };
            result.map_err(case_error)
        },
    );
}
