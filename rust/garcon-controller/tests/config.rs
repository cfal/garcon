#![cfg(not(windows))]

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use garcon_cases::{CaseError, replay, round_tripped};
use garcon_controller::config::{
    ConfigEnvironment, ConfigError, HELP_TEXT, ServerConfig, is_help_requested, parse_server_config,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn parse(
    args: &[String],
    variables: &BTreeMap<String, String>,
) -> Result<ServerConfig, ConfigError> {
    let mut variables = variables.clone();
    variables
        .entry("HOME".into())
        .or_insert_with(|| "/fixture/home".into());
    parse_server_config(
        args,
        &ConfigEnvironment {
            variables: &variables,
            server_root: "/fixture/install",
            process_home: "/fixture/process-home",
        },
    )
}

fn owned_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

fn configure(args: &[&str], variables: &[(&str, &str)]) -> Result<ServerConfig, ConfigError> {
    let variables = variables
        .iter()
        .map(|(key, value)| ((*key).into(), (*value).into()))
        .collect();
    parse(&owned_args(args), &variables)
}

fn decode<T: DeserializeOwned>(name: &str, argument: Option<&Value>) -> Result<T, CaseError> {
    let json = round_tripped(name, argument)?.ok_or_else(|| CaseError::unhandled(name))?;
    serde_json::from_value(json.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn recorded_error(error: ConfigError) -> CaseError {
    match error {
        ConfigError::Invalid(message) => CaseError::new("Error", message),
        ConfigError::Validation(error) => CaseError::new(error.kind.name(), error.message)
            .with_property("code", error.code.as_str())
            .with_property("status", error.status)
            .with_property("retryable", error.retryable),
    }
}

#[test]
fn recorded_configuration_cases_match() {
    const FIXTURE_PROCESS: &str = "GARCON_TEST_CONFIG_FIXTURE_PROCESS";
    if std::env::var_os(FIXTURE_PROCESS).is_none() {
        // The fixture runs at a fixed cwd, but its live HOME must not match
        // the injected process home that the config parser should use.
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recorded_configuration_cases_match",
                "--nocapture",
            ])
            .current_dir("/")
            .env(FIXTURE_PROCESS, "1")
            .env("HOME", "/fixture/live-home")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/config"),
        |function, args| {
            if function != "configFor" {
                return Err(CaseError::unhandled(function));
            }
            let arguments: Vec<String> = decode(function, args.first())?;
            let variables: BTreeMap<String, String> = decode(function, args.get(1))?;
            let config = parse(&arguments, &variables).map_err(recorded_error)?;
            serde_json::to_vec(&config)
                .and_then(|bytes| garcon_js::json::from_slice(&bytes))
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
    assert_eq!(stats.passed, stats.total);
}

#[test]
fn accepts_only_an_http_origin_for_the_published_runtime_url() {
    assert_eq!(configure(&[], &[]).unwrap().runtime_origin, None);
    for (argument, expected) in [
        ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
        ("http://127.0.0.1:80", "http://127.0.0.1"),
    ] {
        let config = configure(&["--runtime-origin", argument], &[]).unwrap();
        assert_eq!(config.runtime_origin.as_deref(), Some(expected));
    }
    for invalid in [
        "http://127.0.0.1:8080/base",
        "https://garcon.test",
        "not a url",
    ] {
        let error = configure(&["--runtime-origin", invalid], &[]).unwrap_err();
        assert!(error.to_string().contains("--runtime-origin"));
    }
}

#[test]
fn trusts_forwarded_addresses_with_the_flag_or_the_environment_variable() {
    assert!(!configure(&[], &[]).unwrap().trust_proxy_enabled);
    assert!(
        configure(&["--trust-proxy"], &[])
            .unwrap()
            .trust_proxy_enabled
    );
    assert!(
        configure(&[], &[("GARCON_TRUST_PROXY", "1")])
            .unwrap()
            .trust_proxy_enabled
    );
}

#[test]
fn public_url_flags_override_environment_preserve_base_paths_and_reject_invalid_configuration() {
    let environment = [
        ("GARCON_PUBLIC_URL", "https://public.test/base"),
        ("GARCON_BASE_PATH", "/base"),
    ];
    assert_eq!(
        configure(&[], &environment).unwrap().public_url.as_deref(),
        Some("https://public.test/base/")
    );
    let config = configure(
        &[
            "--public-url",
            "https://override.test/prefix/",
            "--base-path=/prefix/",
        ],
        &environment,
    )
    .unwrap();
    assert_eq!(
        config.public_url.as_deref(),
        Some("https://override.test/prefix/")
    );
    assert_eq!(config.base_path, "/prefix");
    let error =
        configure(&["--public-url", "https://user:secret@host/"], &environment).unwrap_err();
    assert!(error.to_string().contains("no credentials"));
    let error = configure(&["--public-url", ""], &environment).unwrap_err();
    assert!(error.to_string().contains("absolute HTTP(S)"));
}

#[test]
fn normalizes_and_freezes_the_mount_with_cli_precedence_and_aligned_public_urls() {
    let environment = [("GARCON_BASE_PATH", "/tools/garcon/")];
    let config = configure(&[], &environment).unwrap();
    assert_eq!(config.base_path, "/tools/garcon");
    assert!(
        configure(&["--base-path=/"], &environment)
            .unwrap()
            .base_path
            .is_empty()
    );
    assert_eq!(config.base_path, "/tools/garcon");
    let error = configure(
        &["--base-path=/"],
        &[("GARCON_PUBLIC_URL", "https://public.test/other")],
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Public URL path must match --base-path / GARCON_BASE_PATH"
    );
    assert!(
        configure(&["--base-path=/bad//path"], &[])
            .unwrap_err()
            .to_string()
            .starts_with("Invalid base path")
    );
    assert_eq!(
        configure(&["--base-path"], &[]).unwrap_err().to_string(),
        "--base-path requires a value. Usage: --base-path <path>"
    );
}

#[test]
fn rejects_duplicate_value_flags_and_conflicting_explicit_workspace_selectors() {
    assert_eq!(
        configure(&["--config-dir", "/first", "--config-dir=/second"], &[])
            .unwrap_err()
            .to_string(),
        "Option may be specified only once: --config-dir"
    );
    assert_eq!(
        configure(
            &["--workspace", "named", "--workspace-dir", "/explicit"],
            &[]
        )
        .unwrap_err()
        .to_string(),
        "Choose only one of --workspace or --workspace-dir."
    );
}

#[test]
fn explicit_workspace_paths_override_inherited_names_and_empty_roots_are_rejected() {
    let environment = [
        ("GARCON_CONFIG_DIR", "/inherited"),
        ("GARCON_WORKSPACE_DIR", "/inherited/workspace"),
        ("GARCON_WORKSPACE", "inherited"),
    ];
    let config = configure(&["--workspace-dir", "/explicit/workspace"], &environment).unwrap();
    assert_eq!(config.workspace_dir, "/explicit/workspace");
    assert_eq!(config.workspace_name, None);
    assert_eq!(
        configure(&["--config-dir", ""], &environment)
            .unwrap_err()
            .to_string(),
        "--config-dir must be a non-empty directory path"
    );
}

#[test]
fn preserves_env_and_cli_port_zero_for_os_assigned_binding() {
    assert_eq!(configure(&[], &[("GARCON_PORT", "0")]).unwrap().port, 0);
    assert_eq!(configure(&["--port", "0"], &[]).unwrap().port, 0);
}

#[test]
fn rejects_missing_empty_and_non_integer_port_values() {
    assert_eq!(
        configure(&["--port"], &[]).unwrap_err().to_string(),
        "--port requires a value. Usage: --port <number>"
    );
    assert_eq!(
        configure(&["--port", ""], &[]).unwrap_err().to_string(),
        "Invalid --port value: must be an integer between 0 and 65535."
    );
    assert_eq!(
        configure(&[], &[("GARCON_PORT", "3000.5")])
            .unwrap_err()
            .to_string(),
        "Invalid GARCON_PORT value: 3000.5. Must be an integer between 0 and 65535."
    );
}

#[test]
fn freezes_initialized_config_and_resolves_the_process_home_against_cwd() {
    let mut variables = BTreeMap::from([
        ("HOME".into(), "configured-home".into()),
        ("GARCON_PORT".into(), "9001".into()),
    ]);
    let config = parse(&[], &variables).unwrap();
    variables.insert("GARCON_PORT".into(), "9002".into());
    variables.insert("HOME".into(), "changed-home".into());
    assert_eq!(config.port, 9001);
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        config.home_directory_path,
        cwd.join("configured-home").to_str().unwrap()
    );
    assert_eq!(config.project_base_path, "/fixture/process-home");
}

#[test]
fn validates_websocket_client_limits_during_initialization() {
    for invalid in ["many", "-1"] {
        let error = configure(&[], &[("GARCON_MAX_WS_CLIENTS", invalid)]).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "Invalid GARCON_MAX_WS_CLIENTS value: {invalid}. Must be a non-negative integer."
            )
        );
    }
    assert_eq!(
        configure(&[], &[("GARCON_MAX_WS_CLIENTS", "0")])
            .unwrap_err()
            .to_string(),
        "Invalid GARCON_MAX_WS_CLIENTS value: must be at least 1."
    );
}

#[test]
fn parses_the_explicit_carryover_rollback_startup_flag() {
    assert!(
        configure(&["--rollback-carryover-migration"], &[])
            .unwrap()
            .rollback_carry_over_migration
    );
}

#[test]
fn treats_empty_disable_auth_as_unset_so_the_cli_flag_can_apply() {
    assert!(
        configure(&["--disable-auth"], &[("GARCON_DISABLE_AUTH", "")])
            .unwrap()
            .auth_disabled
    );
}

#[test]
fn http_compression_defaults_to_enabled_and_accepts_false_like_values() {
    assert!(configure(&[], &[]).unwrap().http_compression_enabled);
    assert!(
        !configure(&[], &[("GARCON_HTTP_COMPRESSION", "false")])
            .unwrap()
            .http_compression_enabled
    );
    assert_eq!(
        configure(&[], &[("GARCON_HTTP_COMPRESSION", "maybe")])
            .unwrap_err()
            .to_string(),
        "Invalid GARCON_HTTP_COMPRESSION value: maybe. Must be a boolean-like value."
    );
}

#[test]
fn help_is_only_for_the_controller_and_matches_the_original() {
    assert!(is_help_requested(&owned_args(&["--port", "0", "--help"])));
    assert!(is_help_requested(&owned_args(&["-h"])));
    assert!(!is_help_requested(&owned_args(&["executor", "--help"])));
    assert!(!is_help_requested(&owned_args(&["--help=true"])));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let original = Command::new("bun")
        .args(["server/main.ts", "--help"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(original.status.success());
    assert_eq!(original.stdout, HELP_TEXT.as_bytes());
    assert!(original.stderr.is_empty());
}
