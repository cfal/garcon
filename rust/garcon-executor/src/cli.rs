//! Executor startup arguments. Ports `server/remote/worker-cli.ts`.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::net::Ipv6Addr;
use std::process::ExitCode;

use garcon_contract::cli_runtime_paths::executor_data_directory;
use garcon_contract::config_dir::{
    ConfigDirectoryEnvironment, resolve_config_directory, resolve_home_directory,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{path::native, trim};
use garcon_link::connection_url::{
    ExecutorSocketUrlOptions, executor_connection_url, parse_connection_url,
    validate_executor_socket_url,
};
use garcon_link::websocket_link::ExecutorListenerTls;
use tokio::runtime::Builder;
use tokio::task::LocalSet;
use url::Url;

use crate::listener_secret::read_listener_secret;
use crate::worker::{Executor, ExecutorWorkerOptions, WorkerConnection};

const HELP: &str = "Garcon executor

Usage:
  garcon executor [options]       Dials GARCON_CONTROLLER_URL.
  garcon executor --listen <port> [options]
  garcon executor connection-url --advertise-url <url> [--config-dir <directory>] [--no-tls]

Options:
  --config-dir <directory>     Config root (overrides GARCON_CONFIG_DIR; default: ~/.garcon).
  --project-base-dir <path>    Worker project base (default: home directory).
  --bind-address <host-or-ip>  Listener bind address (default: 0.0.0.0).
  --advertise-url <url>        Public listener endpoint; overrides GARCON_EXECUTOR_ADVERTISE_URL.
  --tls-cert <path>            Listener PEM certificate/chain; requires --tls-private-key.
  --tls-private-key <path>     Listener PEM private key; requires --tls-cert.
  --no-tls                    Explicitly use WS, including behind a TLS proxy.
  --allow-unverified-tls       Skip certificate verification when dialing WSS.
  --help                      Show this help.

GARCON_CONTROLLER_URL contains the full controller URL, including its Noise secret.
Its credential is consumed before runtime startup; PTY children receive an empty variable.
Do not place credentials in argv or shell history. Environment values remain visible
to privileged processes and some diagnostics. Routine startup output omits secrets;
connection-url explicitly reveals an existing listener credential on stdout.
Listeners require both TLS files or --no-tls, never both. Behind a TLS proxy, bind
the --no-tls listener to a protected interface and advertise the public wss: URL.
Noise encryption and shared-secret authentication remain mandatory, even over ws:.
Worker storage is <config-dir>/executor. Use separate roots for independent workers.
Workspace selectors apply only to controllers.
";

#[derive(Default)]
pub(crate) struct Environment(Vec<(OsString, OsString)>);

impl From<Vec<(OsString, OsString)>> for Environment {
    fn from(value: Vec<(OsString, OsString)>) -> Self {
        Self(value)
    }
}

impl Environment {
    fn matches(name: &OsStr, key: &str) -> bool {
        if cfg!(windows) {
            name.eq_ignore_ascii_case(OsStr::new(key))
        } else {
            name == OsStr::new(key)
        }
    }

    fn get(&self, key: &str) -> Option<String> {
        environment_value(&self.0, key)
    }

    fn remove(&mut self, key: &str) -> Option<String> {
        let value = self.get(key);
        self.0.retain(|(name, _)| !Self::matches(name, key));
        value
    }

    fn config(&self) -> ConfigDirectoryEnvironment {
        ConfigDirectoryEnvironment {
            garcon_config_dir: self.get("GARCON_CONFIG_DIR"),
            home: self.get("HOME"),
        }
    }

    pub(crate) fn for_worker(mut self, config_dir: &str) -> Vec<(OsString, OsString)> {
        for key in [
            "GARCON_CONTROLLER_URL",
            "GARCON_AGENT_EXECUTOR_CONFIG",
            "GARCON_WORKSPACE_DIR",
            "GARCON_WORKSPACE",
            "GARCON_CLI_RUNTIME",
            "GARCON_CONFIG_DIR",
            "GARCON_RUNTIME",
        ] {
            self.remove(key);
        }
        self.0.push(("GARCON_CONFIG_DIR".into(), config_dir.into()));
        self.0.push(("GARCON_RUNTIME".into(), "executor".into()));
        self.0
    }
}

pub(crate) fn environment_value(environment: &[(OsString, OsString)], key: &str) -> Option<String> {
    environment
        .iter()
        .rev()
        .find(|(name, _)| Environment::matches(name, key))
        .map(|(_, value)| value.to_string_lossy().into_owned())
}

type Flags<'a> = HashMap<&'a str, Option<&'a str>>;

fn parse_flags(args: &[String], reveal: bool) -> Option<Flags<'_>> {
    let mut input = args.iter().map(String::as_str).peekable();
    let mut flags = HashMap::new();
    while let Some(flag) = input.next() {
        if flag == "--" && input.peek().is_none() {
            break;
        }
        let raw = flag.strip_prefix("--")?;
        let (name, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(name, value)| (name, Some(value)));
        let value = match name {
            "no-tls" => {
                if inline.is_some() {
                    return None;
                }
                None
            }
            "allow-unverified-tls" if !reveal => {
                if inline.is_some() {
                    return None;
                }
                None
            }
            "config-dir" | "advertise-url" => Some(string_flag(inline, &mut input)?),
            "listen" | "project-base-dir" | "bind-address" | "tls-cert" | "tls-private-key"
                if !reveal =>
            {
                Some(string_flag(inline, &mut input)?)
            }
            _ => return None,
        };
        flags.insert(name, value);
    }
    Some(flags)
}

fn string_flag<'a>(
    inline: Option<&'a str>,
    input: &mut impl Iterator<Item = &'a str>,
) -> Option<&'a str> {
    inline.or_else(|| {
        input
            .next()
            .filter(|value| *value == "-" || !value.starts_with('-'))
    })
}

fn flag_value<'a>(flags: &Flags<'a>, key: &str) -> Option<&'a str> {
    flags.get(key).copied().flatten()
}

fn socket_url(url: &str, no_tls: bool) -> ExecutorResult<String> {
    Ok(validate_executor_socket_url(
        url,
        ExecutorSocketUrlOptions {
            no_tls,
            ..Default::default()
        },
    )?)
}

async fn read_worker_cli_options(
    args: &[String],
    environment: &mut Environment,
) -> ExecutorResult<ExecutorWorkerOptions> {
    let controller_url = environment
        .remove("GARCON_CONTROLLER_URL")
        .filter(|url| !url.is_empty());
    if args
        .iter()
        .any(|arg| arg == "--workspace-dir" || arg.starts_with("--workspace-dir="))
    {
        return Err("--workspace-dir is controller-only; use --config-dir <root> for worker storage at <root>/executor".into());
    }
    let flags =
        parse_flags(args, false).ok_or("Invalid executor arguments; use executor --help")?;
    let listen = flag_value(&flags, "listen");
    if controller_url.is_some() == listen.is_some() {
        return Err("Choose exactly one of GARCON_CONTROLLER_URL or --listen".into());
    }
    let config = environment.config();
    let config_dir = resolve_config_directory(flag_value(&flags, "config-dir"), &config, None)?;
    let project_base_path = if let Some(path) = flag_value(&flags, "project-base-dir") {
        path.to_owned()
    } else {
        resolve_home_directory(config.home.as_deref(), None)?
    };
    let cwd = std::env::current_dir()?;
    let project_base_path = native::resolve(&cwd.to_string_lossy(), &[&project_base_path]);
    let no_tls = flags.contains_key("no-tls");
    let allow_unverified_tls = flags.contains_key("allow-unverified-tls");
    let advertised = flag_value(&flags, "advertise-url")
        .map(str::to_owned)
        .or_else(|| environment.get("GARCON_EXECUTOR_ADVERTISE_URL"))
        .filter(|value| !value.is_empty());
    let cert = flag_value(&flags, "tls-cert");
    let key = flag_value(&flags, "tls-private-key");
    let bind_address = flag_value(&flags, "bind-address");
    let (connection, advertised_url) = if let Some(controller_url) = controller_url {
        if bind_address.is_some() {
            return Err("--bind-address applies only to listeners".into());
        }
        if advertised.is_some() {
            return Err(
                "--advertise-url / GARCON_EXECUTOR_ADVERTISE_URL apply only to listeners".into(),
            );
        }
        if cert.is_some() || key.is_some() {
            return Err("TLS certificate and private key apply only to listeners".into());
        }
        let expected = parse_connection_url(&controller_url)?;
        let url = socket_url(&expected.socket_url, no_tls)?;
        if no_tls && url.starts_with("wss:") {
            return Err("--no-tls conflicts with a WSS controller URL".into());
        }
        if no_tls && allow_unverified_tls {
            return Err("--allow-unverified-tls requires WSS".into());
        }
        (
            WorkerConnection::Dial {
                url,
                secret: expected.secret,
            },
            None,
        )
    } else {
        if allow_unverified_tls {
            return Err("--allow-unverified-tls applies only when dialing".into());
        }
        let port = listen
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|value| value.parse().ok())
            .ok_or("Listener port must be between 0 and 65535")?;
        let bind_address = parse_bind_address(bind_address)?;
        if cert.is_some() != key.is_some() {
            return Err("--tls-cert and --tls-private-key must be supplied together".into());
        }
        if no_tls == cert.is_some() {
            return Err("Choose TLS certificate/private key or --no-tls".into());
        }
        let tls = if let (Some(cert), Some(key)) = (cert, key) {
            Some(read_listener_tls(cert, key).await?)
        } else {
            None
        };
        let advertised_url = advertised
            .as_deref()
            .map(|url| socket_url(url, no_tls))
            .transpose()?;
        (
            WorkerConnection::Listen {
                port,
                bind_address,
                tls,
            },
            advertised_url,
        )
    };
    Ok(ExecutorWorkerOptions {
        config_dir,
        project_base_path,
        no_tls,
        allow_unverified_tls,
        connection,
        advertised_url,
    })
}

async fn read_listener_tls(cert: &str, key: &str) -> ExecutorResult<ExecutorListenerTls> {
    const INVALID: &str = "Unable to load a valid TLS certificate/private-key pair";
    let cert = tokio::fs::read(cert).await.map_err(|_| INVALID)?;
    let key = tokio::fs::read(key).await.map_err(|_| INVALID)?;
    let tls = ExecutorListenerTls { cert, key };
    tls.validate().map_err(|_| INVALID)?;
    Ok(tls)
}

fn parse_bind_address(value: Option<&str>) -> ExecutorResult<String> {
    let address = value.map_or("0.0.0.0", trim);
    if address.is_empty() {
        return Err("Listener bind address must be a non-empty hostname or IP address".into());
    }
    if address.contains(':') && address.contains('%') {
        return Err("Scoped IPv6 listener bind addresses are not supported".into());
    }
    let hostname = address
        .strip_prefix('[')
        .and_then(|address| address.strip_suffix(']'))
        .unwrap_or(address);
    let ipv6 = hostname.parse::<Ipv6Addr>().is_ok();
    let invalid = "Listener bind address must be a hostname or IP address without a port";
    if !ipv6
        && hostname.chars().any(|c| {
            matches!(c, ':' | '/' | '\\' | '?' | '#' | '@' | '%' | '[' | ']')
                || trim(&c.to_string()).is_empty()
        })
    {
        return Err(invalid.into());
    }
    let url = if ipv6 {
        format!("http://[{hostname}]")
    } else {
        format!("http://{hostname}")
    };
    let url = Url::parse(&url).map_err(|_| invalid)?;
    let canonical = url.host_str().ok_or(invalid)?;
    Ok(if ipv6 {
        canonical.trim_matches(['[', ']'])
    } else {
        canonical
    }
    .to_owned())
}

async fn show_connection_url(args: &[String], environment: &Environment) -> ExecutorResult<()> {
    let flags =
        parse_flags(args, true).ok_or("Invalid connection-url arguments; use executor --help")?;
    let address = flag_value(&flags, "advertise-url")
        .map(str::to_owned)
        .or_else(|| environment.get("GARCON_EXECUTOR_ADVERTISE_URL"))
        .filter(|value| !value.is_empty())
        .ok_or("connection-url requires --advertise-url or GARCON_EXECUTOR_ADVERTISE_URL")?;
    let url = socket_url(&address, flags.contains_key("no-tls"))?;
    let config_dir = resolve_config_directory(
        flag_value(&flags, "config-dir"),
        &environment.config(),
        None,
    )?;
    let secret = read_listener_secret(&executor_data_directory(&config_dir)).await?;
    println!("{}", executor_connection_url(&url, &secret)?);
    Ok(())
}

async fn run_worker_cli(arguments: &[String], mut environment: Environment) -> ExecutorResult<()> {
    if arguments.iter().any(|arg| arg == "--help" || arg == "-h") {
        environment.remove("GARCON_CONTROLLER_URL");
        print!("{HELP}");
        return Ok(());
    }
    if let Some(("connection-url", rest)) = arguments
        .split_first()
        .map(|(arg, rest)| (arg.as_str(), rest))
    {
        environment.remove("GARCON_CONTROLLER_URL");
        return show_connection_url(rest, &environment).await;
    }
    let options = read_worker_cli_options(arguments, &mut environment).await?;
    Executor::serve(options, environment.0).await
}

/// Runs the executor with the arguments that follow the program name or the
/// `executor` subcommand.
pub fn run(arguments: Vec<String>) -> ExitCode {
    let environment = Environment(std::env::vars_os().collect());
    let result = (|| -> ExecutorResult<()> {
        let driver = Builder::new_current_thread().enable_all().build()?;
        LocalSet::new().block_on(&driver, run_worker_cli(&arguments, environment))
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use garcon_link::connection_url::create_executor_secret;

    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn environment(values: &[(&str, &str)]) -> Environment {
        Environment(
            values
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).into()))
                .collect(),
        )
    }

    #[tokio::test]
    async fn rejects_controller_only_flags_and_consumes_credentials_before_validation() {
        let url = format!(
            "wss://worker.example/executor#secret={}",
            create_executor_secret()
        );
        for (flags, failure) in [
            (
                &["--workspace-dir=/somewhere"][..],
                "--workspace-dir is controller-only; use --config-dir <root> for worker storage at <root>/executor",
            ),
            (
                &["--connect", &url],
                "Invalid executor arguments; use executor --help",
            ),
            (
                &["--listen", "0"],
                "Choose exactly one of GARCON_CONTROLLER_URL or --listen",
            ),
            (
                &["--no-tls"],
                "--no-tls conflicts with a WSS controller URL",
            ),
        ] {
            let mut env = environment(&[("GARCON_CONTROLLER_URL", &url)]);
            let error = read_worker_cli_options(&args(flags), &mut env)
                .await
                .err()
                .unwrap();
            assert_eq!(error.to_string(), failure);
            assert!(env.get("GARCON_CONTROLLER_URL").is_none());
        }
        let mut env = environment(&[("GARCON_CONTROLLER_URL", &url)]);
        let options = read_worker_cli_options(&args(&["--allow-unverified-tls"]), &mut env)
            .await
            .unwrap();
        assert!(options.allow_unverified_tls);
        assert!(
            matches!(options.connection, WorkerConnection::Dial { url, .. } if url == "wss://worker.example/executor")
        );
        assert!(env.get("GARCON_CONTROLLER_URL").is_none());
    }

    #[tokio::test]
    async fn listener_parsing_does_not_create_storage_and_keeps_the_advertised_address_separate() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().to_str().unwrap();
        let mut env = environment(&[
            ("GARCON_CONFIG_DIR", config),
            (
                "GARCON_EXECUTOR_ADVERTISE_URL",
                "wss://proxy.example/prefix?tag=x&tag=y",
            ),
        ]);
        let options = read_worker_cli_options(
            &args(&["--listen=0", "--no-tls", "--bind-address", "127.1"]),
            &mut env,
        )
        .await
        .unwrap();
        assert_eq!(options.config_dir, config);
        assert_eq!(
            options.advertised_url.as_deref(),
            Some("wss://proxy.example/prefix?tag=x&tag=y")
        );
        assert!(
            matches!(options.connection, WorkerConnection::Listen { port: 0, bind_address, tls: None } if bind_address == "127.0.0.1")
        );
        assert!(!root.path().join("executor").exists());
        for (flags, expected) in [
            (
                &["--listen", "65536", "--no-tls"][..],
                "Listener port must be between 0 and 65535",
            ),
            (
                &["--listen", "0"],
                "Choose TLS certificate/private key or --no-tls",
            ),
            (
                &["--listen", "0", "--tls-cert", "cert"],
                "--tls-cert and --tls-private-key must be supplied together",
            ),
            (
                &["--listen", "0", "--no-tls", "--allow-unverified-tls"],
                "--allow-unverified-tls applies only when dialing",
            ),
        ] {
            let error = read_worker_cli_options(&args(flags), &mut env)
                .await
                .err()
                .unwrap();
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn canonicalizes_listener_bind_addresses_and_rejects_ports_and_scoped_ipv6() {
        for (raw, expected) in [
            ("0", "0.0.0.0"),
            ("127.1", "127.0.0.1"),
            ("localhost", "localhost"),
            ("::1", "::1"),
            ("[::1]", "::1"),
            ("::", "::"),
        ] {
            assert_eq!(parse_bind_address(Some(raw)).unwrap(), expected);
        }
        for raw in [
            "localhost:8080",
            "http://localhost",
            "user@localhost",
            "localhost/path",
            "localhost?query",
            "localhost#fragment",
        ] {
            assert_eq!(
                parse_bind_address(Some(raw)).unwrap_err().to_string(),
                "Listener bind address must be a hostname or IP address without a port"
            );
        }
        for raw in ["fe80::1%eth0", "[fe80::1%eth0]"] {
            assert_eq!(
                parse_bind_address(Some(raw)).unwrap_err().to_string(),
                "Scoped IPv6 listener bind addresses are not supported"
            );
        }
    }

    #[test]
    fn worker_children_get_the_worker_selectors_without_inherited_controller_state() {
        let env = environment(&[
            ("GARCON_CONFIG_DIR", "inherited"),
            ("GARCON_RUNTIME", "controller"),
            ("GARCON_CLI_RUNTIME", "controller"),
            ("GARCON_WORKSPACE", "workspace"),
            ("GARCON_WORKSPACE_DIR", "/old/workspace"),
            ("GARCON_CONTROLLER_URL", "secret"),
            ("GARCON_AGENT_EXECUTOR_CONFIG", "old-config"),
            ("TEST_SENTINEL", "keep"),
        ]);
        let env = Environment::from(env.for_worker("/worker"));
        assert_eq!(env.get("GARCON_CONFIG_DIR").as_deref(), Some("/worker"));
        assert_eq!(env.get("GARCON_RUNTIME").as_deref(), Some("executor"));
        assert_eq!(env.get("TEST_SENTINEL").as_deref(), Some("keep"));
        for key in [
            "GARCON_CLI_RUNTIME",
            "GARCON_WORKSPACE",
            "GARCON_WORKSPACE_DIR",
            "GARCON_CONTROLLER_URL",
            "GARCON_AGENT_EXECUTOR_CONFIG",
        ] {
            assert!(env.get(key).is_none(), "{key} was inherited");
        }
    }
}
