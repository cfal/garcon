//! The worker's provider roster. Ports `server/runtime/agents/default-agent-integrations.ts`.

use garcon_agent_direct_anthropic_compatible::DirectAnthropicCompatibleIntegration;
use garcon_agent_direct_openai_compatible::DirectOpenAiCompatibleIntegration;
use garcon_agent_direct_openai_responses_compatible::DirectOpenAiResponsesCompatibleIntegration;
use garcon_agent_opencode::OpenCodeAgentIntegration;
use garcon_interface::integration::AgentIntegrationClass;

pub(crate) fn default_agent_integrations() -> Vec<&'static dyn AgentIntegrationClass> {
    // Original order: Claude, Codex, Direct Responses, Direct Chat, Direct Anthropic,
    // OpenCode, Amp, Cursor, Antigravity, Factory, Pi, Shell (Linux and macOS only).
    vec![
        // Claude
        // Codex
        &DirectOpenAiResponsesCompatibleIntegration,
        &DirectOpenAiCompatibleIntegration,
        &DirectAnthropicCompatibleIntegration,
        &OpenCodeAgentIntegration,
        // Amp
        // Cursor
        // Antigravity
        // Factory
        // Pi
        // Shell (Linux and macOS only)
    ]
}

#[cfg(test)]
mod tests {
    use std::{process::Command, rc::Rc};

    use garcon_interface::testing::{
        AgentIntegrationConformanceOptions, run_agent_integration_conformance,
    };
    use garcon_link::rpc_protocol::{IntegrationManifest, NULLABLE_AGENT_FACETS};
    use garcon_runtime::agents::integration_host::{
        IntegrationHostFactory, IntegrationHostFactoryOptions,
    };
    use garcon_runtime::agents::integration_registry::IntegrationRegistry;
    use serde::Deserialize;

    use super::*;

    const ORIGINAL_ORDER: &[&str] = &[
        "claude",
        "codex",
        "direct-openai-responses-compatible",
        "direct-openai-compatible",
        "direct-anthropic-compatible",
        "opencode",
        "amp",
        "cursor",
        "antigravity",
        "factory",
        "pi",
        "shell",
    ];

    #[derive(Deserialize)]
    struct Metadata {
        packages: Vec<Package>,
    }

    #[derive(Deserialize)]
    struct Package {
        name: String,
        dependencies: Vec<Dependency>,
    }

    #[derive(Deserialize)]
    struct Dependency {
        name: String,
        kind: Option<String>,
    }

    fn expected_roster() -> Vec<String> {
        let metadata = Command::new(env!("CARGO"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args(["metadata", "--format-version", "1", "--locked", "--no-deps"])
            .output()
            .unwrap();
        assert!(
            metadata.status.success(),
            "{}",
            String::from_utf8_lossy(&metadata.stderr)
        );
        let metadata: Metadata = garcon_js::json::from_slice(&metadata.stdout).unwrap();
        let executor = metadata
            .packages
            .into_iter()
            .find(|package| package.name == "garcon-executor")
            .unwrap();
        let mut ids = executor
            .dependencies
            .into_iter()
            .filter(|dependency| dependency.kind.is_none())
            .filter_map(|dependency| {
                dependency
                    .name
                    .strip_prefix("garcon-agent-")
                    .map(str::to_owned)
            })
            .filter(|id| id != "shell" || cfg!(any(target_os = "linux", target_os = "macos")))
            .collect::<Vec<_>>();
        ids.sort_by_key(|id| {
            ORIGINAL_ORDER
                .iter()
                .position(|&known| known == id)
                .unwrap_or_else(|| {
                    panic!("{id} has no position in the original integration roster")
                })
        });
        ids
    }

    #[test]
    fn linked_integration_crates_are_registered_in_original_order() {
        let classes = default_agent_integrations();
        let actual: Vec<_> = classes.iter().map(|class| class.integration_id()).collect();
        assert_eq!(actual, expected_roster());
    }

    #[tokio::test]
    async fn registered_integrations_match_the_manifest_and_conform() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let host = IntegrationHostFactory::new(IntegrationHostFactoryOptions {
                    workspace_dir: root.path().to_str().unwrap().into(),
                    executor_id: Some("local".into()),
                    instance_id: Some("synthetic-executor".into()),
                    resolve_credential: Rc::new(|_| {
                        Box::pin(async { Err("unexpected credential resolution".into()) })
                    }),
                    read_environment: Some(Rc::new(|_| None)),
                    logger_factory: None,
                });
                let classes = default_agent_integrations();
                let registry = IntegrationRegistry::from_classes(&classes, &host).unwrap();
                assert_eq!(registry.list().len(), classes.len());
                for class in classes {
                    let integration = registry.require(class.integration_id()).unwrap();
                    let manifest = IntegrationManifest::from_integration(&integration).unwrap();
                    assert_eq!(manifest.descriptor.id, class.integration_id());
                    assert_eq!(manifest.scope.integration_id, class.integration_id());
                    assert_eq!(
                        manifest
                            .capabilities
                            .keys()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                        NULLABLE_AGENT_FACETS
                    );
                    run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                        integration_id: class.integration_id(),
                        api_version: class.api_version(),
                        integration: integration.as_ref(),
                    })
                    .await
                    .unwrap();
                }
            })
            .await;
    }
}
