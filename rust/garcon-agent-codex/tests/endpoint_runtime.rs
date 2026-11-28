use garcon_agent_codex::{
    app_server::{
        config_overrides::append_codex_config_args,
        endpoint_runtime::{
            assert_codex_session_endpoint, build_codex_app_server_endpoint_runtime,
            build_codex_host_provider_config,
        },
    },
    build::prepare_compiled_runtime::CompiledCodexModelCatalog,
    runtime_types::CodexProviderConfig,
};
use garcon_agents_common::execution::resolve_endpoint::ResolvedAgentEndpoint;
use garcon_cases::{CaseError, markers, replay, text, unknown};
use serde_json::{Value, json};

fn endpoint(value: &Value) -> ResolvedAgentEndpoint {
    ResolvedAgentEndpoint {
        selection: serde_json::from_value(value["selection"].clone()).unwrap(),
        credential: value["credential"].as_str().map(str::to_owned),
    }
}

fn portable_catalog(config: &CodexProviderConfig, catalog: &CompiledCodexModelCatalog) -> Value {
    let mut output = json!(config);
    output["modelCatalogPath"] =
        json!(config.model_catalog_path.as_deref() == catalog.path().to_str());
    output
}

#[test]
fn recorded_endpoint_runtime_matches() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let catalog = runtime
        .block_on(CompiledCodexModelCatalog::prepare())
        .unwrap();
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/endpoint-runtime"),
        |function, args| {
            let first = unknown(function, args.first())?;
            Ok(match function {
                "buildCodexAppServerEndpointRuntime" => runtime
                    .block_on(build_codex_app_server_endpoint_runtime(
                        &endpoint(&first),
                        &catalog,
                    ))
                    .unwrap()
                    .map_or(Value::Null, |result| {
                        json!({
                            "codexConfig": portable_catalog(&result.codex_config, &catalog),
                        })
                    }),
                "buildCodexHostProviderConfig" => runtime
                    .block_on(build_codex_host_provider_config(
                        first["kind"].as_str().unwrap(),
                        &catalog,
                    ))
                    .unwrap()
                    .map_or_else(markers::undefined, |config| {
                        portable_catalog(&config, &catalog)
                    }),
                "assertCodexSessionEndpoint" => assert_codex_session_endpoint(
                    text(function, args.first())?,
                    text(function, args.get(1))?,
                )
                .map_or_else(
                    |error| {
                        json!({
                            "$":"error","name":"AgentIntegrationError","message":error.message,
                            "properties":{"code":error.code.as_str(),"retryable":error.retryable},
                        })
                    },
                    |()| markers::undefined(),
                ),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
    runtime.block_on(catalog.close()).unwrap();
}

#[tokio::test]
async fn keeps_credentials_in_the_spawn_environment_and_blanks_in_literal_headers() {
    let catalog = CompiledCodexModelCatalog::prepare().await.unwrap();
    let selected = endpoint(&json!({
        "selection":{
            "apiProviderId":"fixture","endpointId":"acme_openai","providerLabel":"Acme",
            "protocol":"openai-compatible","baseUrl":"https://example.invalid/v1",
            "capabilities":{"chatCompletions":false,"responses":true},"model":"fixture-code",
            "isLocal":false,"credential":null,
            "headers":{"X.Empty.Header":"  ","X.Gateway.Key":"synthetic-header-secret"},
        },
        "credential":"synthetic-api-key",
    }));
    let config = build_codex_app_server_endpoint_runtime(&selected, &catalog)
        .await
        .unwrap()
        .unwrap()
        .codex_config;
    let mut args = Vec::new();
    append_codex_config_args(&mut args, Some(&Value::Object(config.config))).unwrap();
    let args = args.join(" ");
    assert!(!args.contains("synthetic-api-key"));
    assert!(!args.contains("synthetic-header-secret"));
    assert!(args.contains(r#""X.Empty.Header" = "  ""#));
    assert!(args.contains(r#""X.Gateway.Key" = "GARCON_CODEX_PROVIDER_HEADER_1_ACME_OPENAI""#));
    let env = config.env.unwrap();
    assert_eq!(
        env["GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI"],
        "synthetic-api-key"
    );
    assert_eq!(
        env["GARCON_CODEX_PROVIDER_HEADER_1_ACME_OPENAI"],
        "synthetic-header-secret"
    );
    catalog.close().await.unwrap();
}
