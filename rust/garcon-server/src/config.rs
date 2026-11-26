//! Front-door configuration, parsed with the same precedence as the
//! TypeScript controller (`server/controller/config.ts`): CLI flag, then
//! nonempty environment variable, then default.

use std::path::PathBuf;

/// Flags the front door owns. They are removed from the arguments forwarded to
/// the original, which instead listens on an ephemeral loopback port.
const OWNED_FLAGS: [&str; 3] = ["--port", "--bind-address", "--runtime-origin"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontDoorConfig {
    pub port: u16,
    pub bind_address: String,
    pub base_path: String,
    pub http_compression: bool,
    pub web_build_dir: PathBuf,
    pub original: OriginalCommand,
    pub trust_proxy: bool,
    /// Bytes that may wait for a browser socket before it is dropped.
    pub ws_backpressure_limit: usize,
    /// Arguments forwarded to the original, without the owned flags.
    pub original_args: Vec<String>,
    /// `GARCON_RS_FALLBACK_LOG`: one line per request handed to the original.
    pub fallback_log: Option<PathBuf>,
    /// `GARCON_RS_SHADOW_LOG`: compares every native response with the original's.
    pub shadow_log: Option<PathBuf>,
    /// `GARCON_RS_UNIT_STATIC_ASSETS=original` sends the unit's routes back to
    /// the original without a rebuild.
    pub static_assets_native: bool,
}

/// How to start the TypeScript original.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginalCommand {
    /// The checkout containing `server/main.ts` (`GARCON_RS_ORIGINAL_ROOT`,
    /// default: the working directory).
    pub root: PathBuf,
    /// The Bun executable (`GARCON_RS_BUN`, default: `bun` on `PATH`).
    pub bun: String,
}

impl OriginalCommand {
    pub fn from_environment(environment: &dyn Environment) -> Self {
        let root = environment.var("GARCON_RS_ORIGINAL_ROOT").map_or_else(
            || environment.current_dir(),
            |root| environment.current_dir().join(root),
        );
        let bun = environment
            .var("GARCON_RS_BUN")
            .unwrap_or_else(|| "bun".to_string());
        Self { root, bun }
    }
}

/// How the process should run for the given arguments.
#[derive(Debug, PartialEq, Eq)]
pub enum LaunchMode {
    FrontDoor(Box<FrontDoorConfig>),
    /// Help, executor mode, one-shot maintenance flags, and configuration the
    /// front door cannot parse run the original directly, so its output and
    /// exit status are exactly the original's.
    Original(OriginalCommand),
}

pub trait Environment {
    fn var(&self, name: &str) -> Option<String>;
    fn current_dir(&self) -> PathBuf;
}

pub struct ProcessEnvironment;

impl Environment for ProcessEnvironment {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn current_dir(&self) -> PathBuf {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
}

/// Mirrors `cliValue`: `--flag value` or `--flag=value`, given at most once.
fn cli_value(args: &[String], flag: &str) -> Result<Option<String>, ()> {
    let prefix = format!("{flag}=");
    let matches: Vec<usize> = args
        .iter()
        .enumerate()
        .filter(|(_, argument)| *argument == flag || argument.starts_with(&prefix))
        .map(|(index, _)| index)
        .collect();
    match matches.as_slice() {
        [] => Ok(None),
        [index] => {
            let argument = &args[*index];
            if let Some(value) = argument.strip_prefix(&prefix) {
                return Ok(Some(value.to_string()));
            }
            match args.get(index + 1) {
                Some(value) if !value.starts_with("--") => Ok(Some(value.clone())),
                _ => Err(()),
            }
        }
        _ => Err(()),
    }
}

fn without_owned_flags(args: &[String]) -> Vec<String> {
    let mut forwarded = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for argument in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        let name = argument
            .split_once('=')
            .map_or(argument.as_str(), |(name, _)| name);
        if OWNED_FLAGS.contains(&name) {
            // `--flag value` also owns the next argument; `--flag=value` does not.
            skip_next = name == argument;
            continue;
        }
        forwarded.push(argument.clone());
    }
    forwarded
}

/// Mirrors `parseBasePath` in `common/base-path.ts`.
pub fn parse_base_path(value: &str) -> Option<String> {
    if value.is_empty() || value == "/" {
        return Some(String::new());
    }
    let normalized = value.strip_suffix('/').unwrap_or(value);
    let valid_characters = normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._~/-".contains(character));
    let valid_segments = normalized.get(1..).is_some_and(|rest| {
        rest.split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
    });
    (normalized.len() <= 1024 && normalized.starts_with('/') && valid_characters && valid_segments)
        .then(|| normalized.to_string())
}

/// Mirrors `envBool`.
fn parse_bool(value: Option<String>, fallback: bool) -> Option<bool> {
    let Some(raw) = value else {
        return Some(fallback);
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Mirrors `envInt` and `parsePort`: digits only, after trimming, within the
/// target type's range.
fn parse_unsigned<T: std::str::FromStr>(value: &str) -> Option<T> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse().ok()
}

pub fn launch_mode(args: &[String], environment: &dyn Environment) -> LaunchMode {
    let passthrough = args.first().is_some_and(|first| first == "executor")
        || args.iter().any(|argument| {
            matches!(
                argument.as_str(),
                "--help" | "-h" | "--rollback-carryover-migration"
            )
        });
    if !passthrough && let Some(config) = front_door_config(args, environment) {
        return LaunchMode::FrontDoor(Box::new(config));
    }
    LaunchMode::Original(OriginalCommand::from_environment(environment))
}

fn front_door_config(args: &[String], environment: &dyn Environment) -> Option<FrontDoorConfig> {
    let port = match cli_value(args, "--port")
        .ok()?
        .or_else(|| environment.var("GARCON_PORT"))
    {
        Some(value) => parse_unsigned(&value)?,
        None => 8080,
    };
    let bind_address = cli_value(args, "--bind-address")
        .ok()?
        .or_else(|| environment.var("GARCON_BIND_ADDRESS"))
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    if bind_address.is_empty() {
        return None;
    }
    let base_path = parse_base_path(
        &cli_value(args, "--base-path")
            .ok()?
            .or_else(|| environment.var("GARCON_BASE_PATH"))
            .unwrap_or_default(),
    )?;
    let original = OriginalCommand::from_environment(environment);
    let web_build_dir = environment
        .var("GARCON_WEB_BUILD_DIR")
        .map(|value| environment.current_dir().join(value))
        .unwrap_or_else(|| original.root.join("web").join("build"));
    Some(FrontDoorConfig {
        port,
        bind_address,
        base_path,
        http_compression: parse_bool(environment.var("GARCON_HTTP_COMPRESSION"), true)?,
        web_build_dir,
        original,
        trust_proxy: args.iter().any(|argument| argument == "--trust-proxy")
            || parse_bool(environment.var("GARCON_TRUST_PROXY"), false)?,
        ws_backpressure_limit: match environment.var("GARCON_WS_BACKPRESSURE_LIMIT") {
            Some(value) => parse_unsigned(&value)?,
            None => 2 * 1024 * 1024,
        },
        original_args: without_owned_flags(args),
        fallback_log: environment.var("GARCON_RS_FALLBACK_LOG").map(PathBuf::from),
        shadow_log: environment.var("GARCON_RS_SHADOW_LOG").map(PathBuf::from),
        static_assets_native: environment.var("GARCON_RS_UNIT_STATIC_ASSETS").as_deref()
            != Some("original"),
    })
}

/// Mirrors `listeningServerUrl` in `server/common/server-runtime.ts`.
pub fn listening_server_url(bind_address: &str, port: u16) -> String {
    if bind_address.contains(':') && !bind_address.starts_with('[') {
        format!("http://[{bind_address}]:{port}")
    } else {
        format!("http://{bind_address}:{port}")
    }
}

/// Mirrors `advertisedServerUrl`: the URL local clients use, with wildcard
/// bind addresses replaced by loopback.
pub fn advertised_server_url(bind_address: &str, port: u16) -> String {
    match bind_address {
        "0.0.0.0" | "::" | "[::]" => listening_server_url("127.0.0.1", port),
        _ => listening_server_url(bind_address, port),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeEnvironment(HashMap<&'static str, &'static str>);

    impl Environment for FakeEnvironment {
        fn var(&self, name: &str) -> Option<String> {
            self.0
                .get(name)
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty())
        }

        fn current_dir(&self) -> PathBuf {
            PathBuf::from("/repo")
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn config(values: &[&str], environment: &[(&'static str, &'static str)]) -> LaunchMode {
        launch_mode(
            &args(values),
            &FakeEnvironment(environment.iter().copied().collect()),
        )
    }

    #[test]
    fn reads_front_door_settings_with_empty_values_unset() {
        let LaunchMode::FrontDoor(config) = config(
            &[],
            &[
                ("GARCON_RS_SHADOW_LOG", ""),
                ("GARCON_RS_FALLBACK_LOG", "/tmp/fallback.log"),
                ("GARCON_RS_UNIT_STATIC_ASSETS", "original"),
                ("GARCON_RS_ORIGINAL_ROOT", "checkout"),
                ("GARCON_RS_BUN", "/opt/bun"),
            ],
        ) else {
            panic!("expected front door");
        };
        assert_eq!(config.shadow_log, None);
        assert_eq!(
            config.fallback_log,
            Some(PathBuf::from("/tmp/fallback.log"))
        );
        assert!(!config.static_assets_native);
        assert_eq!(
            config.original,
            OriginalCommand {
                root: PathBuf::from("/repo/checkout"),
                bun: "/opt/bun".to_string()
            }
        );
    }

    #[test]
    fn owns_the_runtime_origin_and_honors_a_trust_proxy_flag() {
        let LaunchMode::FrontDoor(trusted) = config(
            &["--runtime-origin", "http://elsewhere:1", "--trust-proxy"],
            &[],
        ) else {
            panic!("expected front door");
        };
        assert!(trusted.trust_proxy);
        assert_eq!(trusted.original_args, args(&["--trust-proxy"]));
        let LaunchMode::FrontDoor(untrusted) = config(&[], &[]) else {
            panic!("expected front door");
        };
        assert!(!untrusted.trust_proxy);
    }

    #[test]
    fn flags_take_precedence_over_environment() {
        let LaunchMode::FrontDoor(config) = config(
            &[
                "--port=9000",
                "--bind-address",
                "0.0.0.0",
                "--config-dir",
                "/c",
            ],
            &[("GARCON_PORT", "7000"), ("GARCON_BIND_ADDRESS", "::1")],
        ) else {
            panic!("expected front door");
        };
        assert_eq!(config.port, 9000);
        assert_eq!(config.bind_address, "0.0.0.0");
        assert_eq!(config.original_args, args(&["--config-dir", "/c"]));
        assert_eq!(config.web_build_dir, PathBuf::from("/repo/web/build"));
        assert_eq!(config.ws_backpressure_limit, 2 * 1024 * 1024);
    }

    #[test]
    fn unparseable_configuration_runs_the_original() {
        assert!(matches!(
            config(&["--port", "70000"], &[]),
            LaunchMode::Original(_)
        ));
        assert!(matches!(
            config(&["--port", "1", "--port", "2"], &[]),
            LaunchMode::Original(_)
        ));
        assert!(matches!(
            config(&["--base-path", "/a/../b"], &[]),
            LaunchMode::Original(_)
        ));
        assert!(matches!(
            config(&[], &[("GARCON_HTTP_COMPRESSION", "maybe")]),
            LaunchMode::Original(_)
        ));
        assert!(matches!(
            config(&[], &[("GARCON_WS_BACKPRESSURE_LIMIT", "-1")]),
            LaunchMode::Original(_)
        ));
        assert!(matches!(
            config(&["executor", "--port", "1"], &[]),
            LaunchMode::Original(_)
        ));
        assert!(matches!(config(&["-h"], &[]), LaunchMode::Original(_)));
    }

    #[test]
    fn base_path_matches_the_original_rules() {
        assert_eq!(parse_base_path("/"), Some(String::new()));
        assert_eq!(
            parse_base_path("/tools/garcon/"),
            Some("/tools/garcon".to_string())
        );
        assert_eq!(parse_base_path("tools"), None);
        assert_eq!(parse_base_path("/a//b"), None);
        assert_eq!(parse_base_path("/a b"), None);
    }

    #[test]
    fn advertises_loopback_for_wildcard_binds() {
        assert_eq!(advertised_server_url("0.0.0.0", 80), "http://127.0.0.1:80");
        assert_eq!(advertised_server_url("::", 80), "http://127.0.0.1:80");
        assert_eq!(advertised_server_url("::1", 80), "http://[::1]:80");
    }

    #[test]
    fn ipv6_bind_addresses_are_bracketed() {
        assert_eq!(listening_server_url("::1", 80), "http://[::1]:80");
        assert_eq!(listening_server_url("127.0.0.1", 80), "http://127.0.0.1:80");
    }
}
