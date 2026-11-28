//! Ports `server/controller/config.ts`. The resolved configuration is retained
//! for the lifetime of the controller.

use std::collections::BTreeMap;

use garcon_base::domain_error::DomainError;
use garcon_contract::base_path::parse_base_path;
use garcon_contract::config_dir::{ConfigDirectoryEnvironment, resolve_config_directory};
use garcon_js::path::native;
use garcon_js::{Number, is_integer, parse_int, trim};
use garcon_stores::executors::public_url::parse_public_url;
use serde::Serialize;
use url::Url;

pub const HELP_TEXT: &str = include_str!("help.txt");

/// The executor subcommand owns its help before the controller looks for flags.
pub fn is_help_requested(args: &[String]) -> bool {
    args.first().is_none_or(|arg| arg != "executor")
        && args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub config_dir: String,
    pub workspace_dir: String,
    pub workspace_name: Option<String>,
    pub port: u16,
    pub bind_address: String,
    pub public_url: Option<String>,
    pub base_path: String,
    pub jwt_token_expiry: String,
    pub test_environment: bool,
    pub project_base_path: String,
    pub home_directory_path: String,
    pub user_shell: String,
    pub max_request_body_size: Number,
    pub max_connections: Number,
    pub max_ws_clients: Number,
    pub ws_idle_timeout_seconds: Number,
    pub ws_backpressure_limit: Number,
    pub ws_max_payload_length: Number,
    pub http_idle_timeout_seconds: Number,
    pub max_sessions: Number,
    pub auth_disabled: bool,
    pub trust_proxy_enabled: bool,
    pub http_compression_enabled: bool,
    pub runtime_origin: Option<String>,
    pub web_build_dir: String,
    pub rollback_carry_over_migration: bool,
}

/// Process inputs used by the configuration parser. The original takes the
/// OS home and the user's shell independently of other configuration.
pub struct ConfigEnvironment<'a> {
    pub variables: &'a BTreeMap<String, String>,
    pub server_root: &'a str,
    pub process_home: &'a str,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Validation(#[from] DomainError),
}

pub fn initialize_server_config(
    args: &[String],
    server_root: &str,
) -> Result<ServerConfig, ConfigError> {
    let variables = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let process_home = std::env::home_dir().unwrap_or_default();
    parse_server_config(
        args,
        &ConfigEnvironment {
            variables: &variables,
            server_root,
            process_home: &process_home.to_string_lossy(),
        },
    )
}

pub fn parse_server_config(
    args: &[String],
    environment: &ConfigEnvironment<'_>,
) -> Result<ServerConfig, ConfigError> {
    let explicit_config = cli_value(args, CliValueFlag::ConfigDir)?;
    let home = if cfg!(windows) {
        environment.process_home
    } else {
        environment
            .value("HOME")
            .unwrap_or(environment.process_home)
    };
    let config_from_env = environment.value("GARCON_CONFIG_DIR").map(str::to_owned);
    // Select the fallback from this snapshot before the shared resolver can
    // consult the live process home.
    let default_config = (explicit_config.is_none() && config_from_env.is_none())
        .then(|| native::join(&[home, ".garcon"]));
    let config_dir = resolve_config_directory(
        explicit_config.or(default_config.as_deref()),
        &ConfigDirectoryEnvironment {
            garcon_config_dir: config_from_env,
            home: None,
        },
        None,
    )
    .map_err(|error| ConfigError::Invalid(error.to_string()))?;
    let cwd = std::env::current_dir().map_err(|error| ConfigError::Invalid(error.to_string()))?;
    let cwd = cwd.to_string_lossy();
    let (workspace_dir, workspace_name) = parse_workspace(args, environment, &config_dir, &cwd)?;
    let max_ws_clients = environment.int("GARCON_MAX_WS_CLIENTS", 128.0)?;
    let public_url = cli_value(args, CliValueFlag::PublicUrl)?
        .or_else(|| environment.value("GARCON_PUBLIC_URL"));
    let base_path = parse_base_path(
        cli_value(args, CliValueFlag::BasePath)?
            .or_else(|| environment.value("GARCON_BASE_PATH"))
            .unwrap_or_default(),
    )
    .map_err(|error| ConfigError::Invalid(error.to_string()))?;
    let public_url = public_url.map(parse_public_url).transpose()?;
    if public_url
        .as_ref()
        .is_some_and(|url| url.path() != format!("{base_path}/"))
    {
        return Err(ConfigError::Invalid(
            "Public URL path must match --base-path / GARCON_BASE_PATH".into(),
        ));
    }
    if max_ws_clients.0 < 1.0 {
        return Err(ConfigError::Invalid(
            "Invalid GARCON_MAX_WS_CLIENTS value: must be at least 1.".into(),
        ));
    }
    Ok(ServerConfig {
        config_dir,
        workspace_dir,
        workspace_name,
        port: parse_port_config(args, environment)?,
        bind_address: non_empty_value(
            cli_value(args, CliValueFlag::BindAddress)?
                .or_else(|| environment.value("GARCON_BIND_ADDRESS")),
            "Invalid --bind-address value: must be a non-empty hostname or IP address.",
        )?
        .unwrap_or("127.0.0.1")
        .to_owned(),
        public_url: public_url.map(Into::into),
        base_path: base_path.to_owned(),
        jwt_token_expiry: environment
            .value("GARCON_JWT_TOKEN_EXPIRY")
            .unwrap_or("30d")
            .into(),
        test_environment: environment.value("NODE_ENV") == Some("test"),
        project_base_path: non_empty_value(
            cli_value(args, CliValueFlag::ProjectBaseDir)?
                .or_else(|| environment.value("GARCON_PROJECT_BASE_DIR")),
            "Invalid --project-base-dir value: must be a non-empty directory path.",
        )?
        .map_or_else(
            || environment.process_home.to_owned(),
            |path| resolve_path(&cwd, path),
        ),
        home_directory_path: resolve_path(&cwd, home),
        user_shell: environment.user_shell().to_owned(),
        max_request_body_size: environment
            .int("GARCON_MAX_REQUEST_BODY_SIZE", 50.0 * 1024.0 * 1024.0)?,
        max_connections: environment.int("GARCON_MAX_CONNECTIONS", 1024.0)?,
        max_ws_clients,
        ws_idle_timeout_seconds: environment.int("GARCON_WS_IDLE_TIMEOUT_SECONDS", 16.0 * 60.0)?,
        ws_backpressure_limit: environment
            .int("GARCON_WS_BACKPRESSURE_LIMIT", 2.0 * 1024.0 * 1024.0)?,
        ws_max_payload_length: environment
            .int("GARCON_WS_MAX_PAYLOAD_LENGTH", 16.0 * 1024.0 * 1024.0)?,
        http_idle_timeout_seconds: environment
            .int("GARCON_HTTP_IDLE_TIMEOUT_SECONDS", 2.0 * 60.0)?,
        max_sessions: environment.int("GARCON_MAX_SESSIONS", 50.0)?,
        auth_disabled: parse_auth_disabled(args, environment)?,
        trust_proxy_enabled: has_flag(args, "--trust-proxy")
            || environment.boolean("GARCON_TRUST_PROXY", false)?,
        http_compression_enabled: environment.boolean("GARCON_HTTP_COMPRESSION", true)?,
        runtime_origin: parse_runtime_origin(cli_value(args, CliValueFlag::RuntimeOrigin)?)?,
        web_build_dir: environment.value("GARCON_WEB_BUILD_DIR").map_or_else(
            || resolve_path(environment.server_root, "web/build"),
            |path| resolve_path(&cwd, path),
        ),
        rollback_carry_over_migration: has_flag(args, "--rollback-carryover-migration"),
    })
}

#[derive(Clone, Copy)]
enum CliValueFlag {
    ConfigDir,
    WorkspaceDir,
    Workspace,
    Port,
    BindAddress,
    ProjectBaseDir,
    PublicUrl,
    BasePath,
    RuntimeOrigin,
}

impl CliValueFlag {
    fn usage(self) -> (&'static str, &'static str) {
        match self {
            Self::ConfigDir => ("--config-dir", "<directory>"),
            Self::WorkspaceDir => ("--workspace-dir", "<directory>"),
            Self::Workspace => ("--workspace", "<name>"),
            Self::Port => ("--port", "<number>"),
            Self::BindAddress => ("--bind-address", "<hostname-or-ip>"),
            Self::ProjectBaseDir => ("--project-base-dir", "<directory>"),
            Self::PublicUrl => ("--public-url", "<url>"),
            Self::BasePath => ("--base-path", "<path>"),
            Self::RuntimeOrigin => ("--runtime-origin", "<origin>"),
        }
    }
}

fn cli_value(args: &[String], option: CliValueFlag) -> Result<Option<&str>, ConfigError> {
    let (flag, value_name) = option.usage();
    let mut matches = args.iter().enumerate().filter_map(|(index, argument)| {
        let rest = argument.strip_prefix(flag)?;
        if rest.is_empty() {
            Some((index, None))
        } else {
            rest.strip_prefix('=').map(|value| (index, Some(value)))
        }
    });
    let Some((index, value)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(ConfigError::Invalid(format!(
            "Option may be specified only once: {flag}"
        )));
    }
    if let Some(value) = value {
        return Ok(Some(value));
    }
    args.get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .map(|value| Some(value.as_str()))
        .ok_or_else(|| {
            ConfigError::Invalid(format!(
                "{flag} requires a value. Usage: {flag} {value_name}"
            ))
        })
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|argument| argument == flag)
}

fn non_empty_value<'a>(
    value: Option<&'a str>,
    error_message: &str,
) -> Result<Option<&'a str>, ConfigError> {
    if value.is_some_and(|value| trim(value).is_empty()) {
        return Err(ConfigError::Invalid(error_message.into()));
    }
    Ok(value)
}

fn parse_port_config(
    args: &[String],
    environment: &ConfigEnvironment<'_>,
) -> Result<u16, ConfigError> {
    if let Some(value) = cli_value(args, CliValueFlag::Port)? {
        return parse_port(value, "--port");
    }
    environment
        .value("GARCON_PORT")
        .map_or(Ok(8080), |value| parse_port(value, "GARCON_PORT"))
}

fn parse_port(value: &str, source: &str) -> Result<u16, ConfigError> {
    let normalized = trim(value);
    if normalized.is_empty() {
        return Err(ConfigError::Invalid(format!(
            "Invalid {source} value: must be an integer between 0 and 65535."
        )));
    }
    let parsed = match normalized.as_bytes() {
        [b'0', radix @ (b'x' | b'X' | b'b' | b'B' | b'o' | b'O'), ..] => {
            let radix = match radix.to_ascii_lowercase() {
                b'x' => 16,
                b'b' => 2,
                _ => 8,
            };
            let digits = &normalized[2..];
            if !digits.chars().all(|character| character.is_digit(radix)) {
                None
            } else {
                parse_int(digits, radix)
            }
        }
        _ => normalized.parse::<f64>().ok(),
    };
    match parsed {
        Some(port) if is_integer(port) && (0.0..=65535.0).contains(&port) => Ok(port as u16),
        _ => Err(ConfigError::Invalid(format!(
            "Invalid {source} value: {value}. Must be an integer between 0 and 65535."
        ))),
    }
}

fn parse_workspace(
    args: &[String],
    environment: &ConfigEnvironment<'_>,
    config_dir: &str,
    cwd: &str,
) -> Result<(String, Option<String>), ConfigError> {
    let explicit_directory = cli_value(args, CliValueFlag::WorkspaceDir)?;
    let explicit_name = cli_value(args, CliValueFlag::Workspace)?;
    if explicit_directory.is_some() && explicit_name.is_some() {
        return Err(ConfigError::Invalid(
            "Choose only one of --workspace or --workspace-dir.".into(),
        ));
    }
    let environment_directory = || {
        if explicit_name.is_none() {
            environment.value("GARCON_WORKSPACE_DIR")
        } else {
            None
        }
    };
    if let Some(directory) = non_empty_value(
        explicit_directory.or_else(environment_directory),
        "Invalid --workspace-dir value: must be a non-empty directory path.",
    )? {
        return Ok((resolve_path(cwd, directory), None));
    }
    let name = non_empty_value(
        explicit_name.or_else(|| environment.value("GARCON_WORKSPACE")),
        "Invalid --workspace value: must be a non-empty name.",
    )?
    .unwrap_or("default");
    if matches!(name, "." | "..") || name.contains(['\\', '/', '\0']) {
        return Err(ConfigError::Invalid(
            "Invalid workspace name: must not contain path separators.".into(),
        ));
    }
    Ok((
        resolve_path(config_dir, &format!("workspace-{name}")),
        Some(name.to_owned()),
    ))
}

fn resolve_path(cwd: &str, path: &str) -> String {
    native::resolve(cwd, &[path])
}

fn parse_runtime_origin(value: Option<&str>) -> Result<Option<String>, ConfigError> {
    let Some(value) = value else { return Ok(None) };
    let url = Url::parse(value)
        .map_err(|_| ConfigError::Invalid(format!("Invalid --runtime-origin value: {value}")))?;
    if url.scheme() != "http" || url.path() != "/" || has_url_suffix(&url) {
        return Err(ConfigError::Invalid(format!(
            "Invalid --runtime-origin value: {value}. Must be an http origin such as http://127.0.0.1:8080."
        )));
    }
    Ok(Some(url.origin().ascii_serialization()))
}

fn has_url_suffix(url: &Url) -> bool {
    !url.username().is_empty()
        || url.password().is_some_and(|value| !value.is_empty())
        || url.query().is_some_and(|value| !value.is_empty())
        || url.fragment().is_some_and(|value| !value.is_empty())
}

fn parse_auth_disabled(
    args: &[String],
    environment: &ConfigEnvironment<'_>,
) -> Result<bool, ConfigError> {
    if has_flag(args, "--disable-auth") {
        return Ok(true);
    }
    if environment
        .value("GARCON_DISABLE_AUTH")
        .is_some_and(|raw| !trim(raw).is_empty())
    {
        return environment.boolean("GARCON_DISABLE_AUTH", false);
    }
    Ok(false)
}

impl ConfigEnvironment<'_> {
    fn user_shell(&self) -> &str {
        if cfg!(windows) {
            "powershell.exe"
        } else {
            self.value("GARCON_TERMINAL_SHELL")
                .or_else(|| self.value("SHELL"))
                .unwrap_or("/bin/bash")
        }
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.variables
            .get(name)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    }

    fn int(&self, name: &str, fallback: f64) -> Result<Number, ConfigError> {
        let Some(raw) = self.value(name) else {
            return Ok(Number(fallback));
        };
        let normalized = trim(raw);
        if normalized.is_empty() || !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ConfigError::Invalid(format!(
                "Invalid {name} value: {raw}. Must be a non-negative integer."
            )));
        }
        Ok(Number(normalized.parse().unwrap_or(f64::INFINITY)))
    }

    fn boolean(&self, name: &str, fallback: bool) -> Result<bool, ConfigError> {
        let Some(raw) = self.value(name) else {
            return Ok(fallback);
        };
        match trim(raw).to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(ConfigError::Invalid(format!(
                "Invalid {name} value: {raw}. Must be a boolean-like value."
            ))),
        }
    }
}
