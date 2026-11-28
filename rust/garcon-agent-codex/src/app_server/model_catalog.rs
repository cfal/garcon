use garcon_interface::resources::ExecutorResult;

use crate::{
    build::prepare_compiled_runtime::CompiledCodexModelCatalog, runtime_types::CodexProviderConfig,
};

pub async fn resolve_codex_model_catalog_path(
    catalog: &CompiledCodexModelCatalog,
) -> ExecutorResult<String> {
    let path = catalog.path();
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return Err(std::io::Error::other(format!(
            "Garcon's bundled Codex model catalog is missing: {}",
            path.display()
        ))
        .into());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub async fn with_codex_model_catalog(
    catalog: &CompiledCodexModelCatalog,
    provider: Option<CodexProviderConfig>,
) -> ExecutorResult<CodexProviderConfig> {
    let mut provider = provider.unwrap_or_default();
    if provider.model_catalog_path.is_none() {
        provider.model_catalog_path = Some(resolve_codex_model_catalog_path(catalog).await?);
    }
    Ok(provider)
}
