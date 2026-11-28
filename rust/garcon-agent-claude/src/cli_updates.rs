use std::rc::Rc;

use futures::FutureExt;
use garcon_agents_common::cli_update::{
    cli_update_service::{
        CliUpdateService, CliUpdateServiceOptions, CliUpdateTarget, NativeReleaseSource,
    },
    install_resolution::{CliInstallDefinition, NativeCliInstaller},
    installer_environment::installer_environment,
    latest_version::channel_latest_version,
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{json, path::native as path, trim};
use indexmap::IndexMap;
use tokio::fs;

use crate::{
    cli_version::ClaudeCliVersionProbe,
    config::ClaudeConfig,
    execution::system_home_dir,
    native_path::{ClaudeNativePathOptions, claude_config_home_dir},
};

const CLAUDE_RELEASES_URL: &str = "https://downloads.claude.ai/claude-code-releases";

fn managed_settings_path() -> Option<&'static str> {
    match std::env::consts::OS {
        "macos" => Some("/Library/Application Support/ClaudeCode/managed-settings.json"),
        "linux" => Some("/etc/claude-code/managed-settings.json"),
        _ => None,
    }
}

pub fn create_claude_cli_updates(
    config: ClaudeConfig,
    version_probe: Rc<ClaudeCliVersionProbe>,
    logger: Rc<dyn AgentLogger>,
) -> CliUpdateService {
    CliUpdateService::new(CliUpdateServiceOptions {
        label: "Claude Code".into(),
        definition: CliInstallDefinition {
            package_name: "@anthropic-ai/claude-code".into(),
            native: NativeCliInstaller {
                // A plain wrapper in ~/.local/bin is not a native release launcher.
                // https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/Drivers/ClaudeMaintenance.ts#L27-L45
                owns_command_path: Rc::new(|path| {
                    path.ends_with("/.local/bin/claude.exe")
                        || path.contains("/.local/share/claude/")
                        || path.contains("/claude/versions/")
                }),
                args: vec!["update".into()],
                env: None,
            },
        },
        target: Rc::new({
            let config = config.clone();
            move || {
                let config = config.clone();
                async move {
                    Ok(CliUpdateTarget {
                        command: config.binary()?,
                        bundled: false,
                    })
                }
                .boxed_local()
            }
        }),
        environment: Rc::new({
            let config = config.clone();
            move || {
                let overrides = config
                    .config_home_dir()?
                    .map_or_else(IndexMap::new, |home| {
                        IndexMap::from([("CLAUDE_CONFIG_DIR".into(), home)])
                    });
                Ok(installer_environment(overrides))
            }
        }),
        native_release: Rc::new(move || {
            let config = config.clone();
            async move {
                let channel = read_claude_release_channel(&config, managed_settings_path()).await?;
                let url = format!("{CLAUDE_RELEASES_URL}/{channel}");
                Ok(NativeReleaseSource {
                    key: url.clone(),
                    lookup: channel_latest_version(url, |body| Some(trim(body).to_owned())),
                })
            }
            .boxed_local()
        }),
        on_updated: Some(Rc::new(move || version_probe.invalidate())),
        logger,
        clock: None,
    })
}

pub async fn read_claude_release_channel(
    config: &ClaudeConfig,
    managed_path: Option<&str>,
) -> ExecutorResult<&'static str> {
    let home_dir = system_home_dir();
    let config_home = config.config_home_dir()?;
    let user_path = path::join(&[
        &claude_config_home_dir(&ClaudeNativePathOptions {
            home_dir: &home_dir,
            config_home_dir: config_home.as_deref(),
            logger: None,
        }),
        "settings.json",
    ]);
    let mut channel = "latest";
    for settings_path in [Some(user_path.as_str()), managed_path]
        .into_iter()
        .flatten()
    {
        if !settings_path.is_empty()
            && let Some(configured) = read_channel_setting(settings_path).await
        {
            channel = configured;
        }
    }
    Ok(channel)
}

async fn read_channel_setting(settings_path: &str) -> Option<&'static str> {
    let bytes = fs::read(settings_path).await.ok()?;
    let settings = json::parse(&String::from_utf8_lossy(&bytes)).ok()?;
    match settings["autoUpdatesChannel"].as_str() {
        Some("latest") => Some("latest"),
        Some("stable") => Some("stable"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use garcon_interface::host::AgentEnvironmentReader;

    use super::*;
    use crate::config::create_claude_config;

    struct Environment(String);

    impl AgentEnvironmentReader for Environment {
        fn get(&self, key: &str) -> ExecutorResult<Option<String>> {
            assert_eq!(key, "CLAUDE_CONFIG_DIR");
            Ok(Some(self.0.clone()))
        }
    }

    #[tokio::test]
    async fn reads_release_channel_with_managed_settings_taking_precedence() {
        let root = tempfile::tempdir().unwrap();
        let user_dir = root.path().join("claude");
        let user = user_dir.join("settings.json");
        let managed = root.path().join("managed-settings.json");
        let config = create_claude_config(Rc::new(Environment(
            user_dir.to_string_lossy().into_owned(),
        )));
        let read = || read_claude_release_channel(&config, managed.to_str());
        let original = || async {
            let output = tokio::process::Command::new("bun")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/cli-updates.ts"
                ))
                .arg(&user_dir)
                .arg(&managed)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        };

        assert_eq!(read().await.unwrap(), "latest");
        assert_eq!(read().await.unwrap(), original().await);
        fs::create_dir(&user_dir).await.unwrap();
        fs::write(&user, r#"{"autoUpdatesChannel":"stable"}"#)
            .await
            .unwrap();
        assert_eq!(read().await.unwrap(), "stable");
        assert_eq!(read().await.unwrap(), original().await);
        fs::write(&managed, r#"{"autoUpdatesChannel":"latest"}"#)
            .await
            .unwrap();
        assert_eq!(read().await.unwrap(), "latest");
        assert_eq!(read().await.unwrap(), original().await);
        fs::write(&managed, r#"{"autoUpdatesChannel":"nightly"}"#)
            .await
            .unwrap();
        assert_eq!(read().await.unwrap(), "stable");
        assert_eq!(read().await.unwrap(), original().await);
        fs::write(&managed, b"{ invalid").await.unwrap();
        assert_eq!(read().await.unwrap(), "stable");
        assert_eq!(read().await.unwrap(), original().await);
    }
}
