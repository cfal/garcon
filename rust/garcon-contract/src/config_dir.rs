//! Config root selection shared by the controller, executor, and CLI.

use std::env;
use std::io;

use garcon_js::{path::native, trim};

#[derive(Debug, Clone, Default)]
pub struct ConfigDirectoryEnvironment {
    pub garcon_config_dir: Option<String>,
    pub home: Option<String>,
}

impl ConfigDirectoryEnvironment {
    pub fn from_process() -> Self {
        Self {
            garcon_config_dir: env::var_os("GARCON_CONFIG_DIR")
                .map(|s| s.to_string_lossy().into_owned()),
            home: env::var_os("HOME").map(|s| s.to_string_lossy().into_owned()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigDirectoryError {
    #[error("--config-dir must be a non-empty directory path")]
    Empty,
    #[error("could not determine the home directory")]
    HomeDirectoryUnavailable,
    #[error(transparent)]
    WorkingDirectory(#[from] io::Error),
}

pub fn resolve_home_directory(
    home: Option<&str>,
    platform: Option<&str>,
) -> Result<String, ConfigDirectoryError> {
    let windows = platform.map_or(cfg!(windows), |platform| platform == "win32");
    if !windows && let Some(home) = home.filter(|home| !home.is_empty()) {
        return Ok(home.to_owned());
    }
    env::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .ok_or(ConfigDirectoryError::HomeDirectoryUnavailable)
}

pub fn resolve_config_directory(
    explicit: Option<&str>,
    environment: &ConfigDirectoryEnvironment,
    platform: Option<&str>,
) -> Result<String, ConfigDirectoryError> {
    let default;
    let value = if let Some(value) = explicit.or_else(|| {
        environment
            .garcon_config_dir
            .as_deref()
            .filter(|value| !value.is_empty())
    }) {
        value
    } else {
        default = native::join(&[
            &resolve_home_directory(environment.home.as_deref(), platform)?,
            ".garcon",
        ]);
        &default
    };
    if trim(value).is_empty() {
        return Err(ConfigDirectoryError::Empty);
    }
    if cfg!(unix) && native::is_absolute(value) {
        return Ok(native::resolve("", &[value]));
    }
    let cwd = env::current_dir()?;
    Ok(native::resolve(&cwd.to_string_lossy(), &[value]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_then_nonempty_environment_then_home_determine_the_config_root() {
        let environment = ConfigDirectoryEnvironment {
            garcon_config_dir: Some("environment/path".into()),
            home: Some("user/home".into()),
        };
        let cwd = env::current_dir().unwrap();
        let cwd = cwd.to_string_lossy();
        assert_eq!(
            resolve_config_directory(Some("explicit"), &environment, None).unwrap(),
            native::resolve(&cwd, &["explicit"])
        );
        assert_eq!(
            resolve_config_directory(None, &environment, None).unwrap(),
            native::resolve(&cwd, &["environment/path"])
        );
        assert_eq!(
            resolve_config_directory(
                None,
                &ConfigDirectoryEnvironment {
                    garcon_config_dir: Some(String::new()),
                    ..environment.clone()
                },
                Some("linux")
            )
            .unwrap(),
            native::resolve(&cwd, &["user/home/.garcon"])
        );
        assert!(matches!(
            resolve_config_directory(Some(""), &environment, None),
            Err(ConfigDirectoryError::Empty)
        ));
        assert!(matches!(
            resolve_config_directory(
                None,
                &ConfigDirectoryEnvironment {
                    garcon_config_dir: Some("\u{a0}".into()),
                    ..environment
                },
                None
            ),
            Err(ConfigDirectoryError::Empty)
        ));
    }

    #[test]
    fn windows_ignores_the_explicit_home_environment() {
        let system_home = env::home_dir().unwrap();
        for (home, platform, expected) in [
            (Some("msys/home"), "win32", system_home.to_str().unwrap()),
            (Some("user/home"), "linux", "user/home"),
            (Some(""), "darwin", system_home.to_str().unwrap()),
        ] {
            assert_eq!(
                resolve_home_directory(home, Some(platform)).unwrap(),
                expected
            );
        }
    }
}
