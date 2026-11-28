use garcon_agent_codex::{
    app_server::model_catalog::{resolve_codex_model_catalog_path, with_codex_model_catalog},
    build::prepare_compiled_runtime::CompiledCodexModelCatalog,
    runtime_types::CodexProviderConfig,
};
use garcon_js::json::from_slice;
use serde_json::{Map, Value, json};

const ORIGINAL_CATALOG: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../server-agents/codex/src/agents/codex/app-server/codex-model-catalog.json",
);

#[tokio::test]
async fn materializes_the_original_catalog_privately_for_the_cli_and_cleans_up() {
    let catalog = CompiledCodexModelCatalog::prepare().await.unwrap();
    let path = catalog.path().to_path_buf();
    let config = with_codex_model_catalog(&catalog, None).await.unwrap();
    assert_eq!(config.model_catalog_path.as_deref(), path.to_str());
    assert!(config.config.is_empty());
    let written = tokio::fs::read(&path).await.unwrap();
    let original = tokio::fs::read(ORIGINAL_CATALOG).await.unwrap();
    assert!(
        written == original,
        "bundled catalog bytes differ from the original"
    );
    let contents: Value = from_slice(&written).unwrap();
    let models = contents["models"].as_array().unwrap();
    let model = |slug| models.iter().find(|model| model["slug"] == slug).unwrap();
    for slug in ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-astra", "gpt-6.1-sol"] {
        assert!(
            model(slug)["service_tiers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tier| tier["id"] == "ultrafast")
        );
    }
    let terra = model("gpt-6.1-terra");
    assert_eq!(terra["multi_agent_version"], "v2");
    assert!(
        terra["service_tiers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tier| tier["id"] != "ultrafast")
    );
    assert_eq!(
        model("gpt-6.2-sol")["input_modalities"],
        json!(["text", "image", "audio"])
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            tokio::fs::metadata(&path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    catalog.close().await.unwrap();
    assert!(!tokio::fs::try_exists(&path).await.unwrap());
}

#[tokio::test]
async fn preserves_an_explicitly_configured_catalog_even_if_the_bundle_is_missing() {
    let catalog = CompiledCodexModelCatalog::prepare().await.unwrap();
    tokio::fs::remove_file(catalog.path()).await.unwrap();
    assert_eq!(
        resolve_codex_model_catalog_path(&catalog)
            .await
            .unwrap_err()
            .to_string(),
        format!(
            "Garcon's bundled Codex model catalog is missing: {}",
            catalog.path().display()
        )
    );
    let configured = CodexProviderConfig {
        config: Map::new(),
        env: None,
        model_catalog_path: Some("/custom/models.json".into()),
    };
    assert_eq!(
        with_codex_model_catalog(&catalog, Some(configured.clone()))
            .await
            .unwrap(),
        configured
    );
    catalog.close().await.unwrap();
}
