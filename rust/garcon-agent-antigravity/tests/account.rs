#![cfg(unix)]

mod support;

use std::{path::Path, rc::Rc, time::Duration};

use garcon_agent_antigravity::{
    antigravity_account::AntigravityAccount,
    antigravity_auth::antigravity_login_environment,
    antigravity_models::run_antigravity_models,
    config::{AntigravityConfig, child_environment},
};
use garcon_agents_common::direct::conformance_host::conformance_host;
use garcon_contract::{agent_auth::AgentAuthLoginStatus, agent_execution::AgentAuthSource};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentLogger,
    services::{AgentCatalogRequest, RequireNativeDiscovery},
};
use support::{bounded, environment, executable};
use tokio::{fs, time::sleep};
use tokio_util::sync::CancellationToken;

fn logger(root: &Path) -> Rc<dyn AgentLogger> {
    conformance_host("antigravity", root).unwrap().logger
}

fn catalog_request(strict: bool, require_native_discovery: bool) -> AgentCatalogRequest {
    AgentCatalogRequest {
        strict,
        require_native_discovery: require_native_discovery.then_some(RequireNativeDiscovery),
        signal: CancellationToken::new(),
        timeout_ms: None,
        dispatch_deadline: None,
    }
}

fn error_code(error: Box<dyn std::error::Error>) -> Code {
    error.downcast::<AgentIntegrationError>().unwrap().code
}

#[tokio::test]
async fn does_not_offer_default_for_an_unlaunchable_cli_or_invalid_auth_method() {
    bounded(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy");
        executable(
            &binary,
            &format!("#!{}\n", root.path().join("missing-interpreter").display()),
        );
        for (method, expected) in [
            ("oauth-personal", Code::BINARY_NOT_FOUND),
            ("gemini-api-key", Code::BINARY_NOT_FOUND),
            ("invalid-method", Code::INVALID_SETTINGS),
        ] {
            let config =
                AntigravityConfig::new(environment(&binary, Some(method), Some("test-key")));
            let account = AntigravityAccount::new(config, logger(root.path()));
            assert!(
                account
                    .catalog
                    .snapshot(catalog_request(false, false))
                    .await
                    .unwrap()
                    .models
                    .is_empty()
            );
            assert_eq!(
                error_code(
                    account
                        .catalog
                        .snapshot(catalog_request(true, false))
                        .await
                        .unwrap_err()
                ),
                expected
            );
            let status = account.auth.status(CancellationToken::new()).await.unwrap();
            assert!(!status.authenticated && !status.can_reauth);
            if method == "oauth-personal" {
                let login = account.auth.login_capabilities().launch_login.unwrap();
                assert_eq!(
                    error_code(login.launch_login().await.unwrap_err()),
                    Code::BINARY_NOT_FOUND
                );
            }
            account.stop();
        }
    })
    .await;
}

#[tokio::test]
async fn keeps_default_on_listing_failure_but_does_not_claim_native_discovery_succeeded() {
    bounded(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy");
        executable(&binary, "#!/bin/sh\nprintf 'Fetching available models...\\nError: Please sign in.\\n' >&2\nexit 7\n");
        let config = AntigravityConfig::new(environment(&binary, None, None));
        let account = AntigravityAccount::new(config, logger(root.path()));
        for strict in [false, true] {
            let models = account.catalog.snapshot(catalog_request(strict, false)).await.unwrap().models;
            assert_eq!(models.iter().map(|model| model.value.as_str()).collect::<Vec<_>>(), ["default"]);
        }
        let error = account.catalog.snapshot(catalog_request(true, true)).await.unwrap_err();
        assert_eq!(error.to_string(), "agy models exited with code 7: Please sign in.");
        assert_eq!(error_code(error), Code::UNAVAILABLE);
    }).await;
}

#[tokio::test]
async fn model_listing_timeout_includes_child_pipe_drain() {
    bounded(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy");
        executable(
            &binary,
            "#!/bin/sh\nprintf 'Fetching available models...\\n'\nsleep 0.2 &\nexit 0\n",
        );
        let config = AntigravityConfig::new(environment(&binary, None, None));
        let error = run_antigravity_models(&config, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "agy models timed out after 20 ms");
    })
    .await;
}

#[tokio::test]
async fn shares_first_listing_reuses_it_and_prefers_native_default() {
    bounded(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy");
        let script = "#!/bin/sh\nprintf 'run\\n' >> \"$(dirname \"$0\")/runs\"\nprintf 'model-a\\tModel A\\ndefault\\tOther\\n'\nprintf 'diagnostic\\n' >&2\n";
        executable(&binary, script);
        let config = AntigravityConfig::new(environment(&binary, None, None));
        let account = AntigravityAccount::new(config, logger(root.path()));
        let list = || account.catalog.snapshot(catalog_request(true, false));
        let snapshots = tokio::try_join!(list(), list()).unwrap();
        for snapshot in [snapshots.0, snapshots.1, list().await.unwrap()] {
            assert_eq!(snapshot.default_model, "default");
            assert_eq!(snapshot.models.iter().map(|model| (model.value.as_str(), model.label.as_str())).collect::<Vec<_>>(),
                [("default", "Default"), ("model-a", "Model A")]);
        }
        assert_eq!(fs::read_to_string(root.path().join("runs")).await.unwrap(), "run\n");
    }).await;
}

#[tokio::test]
async fn api_key_status_runs_version_only_and_does_not_offer_login() {
    bounded(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy");
        executable(
            &binary,
            "#!/bin/sh\ntest \"$1\" = --version && test \"$GEMINI_API_KEY\" = test-key\n",
        );
        let config = AntigravityConfig::new(environment(&binary, None, Some(" test-key ")));
        let account = AntigravityAccount::new(config, logger(root.path()));
        let status = account.auth.status(CancellationToken::new()).await.unwrap();
        assert!(status.authenticated && !status.can_reauth);
        assert_eq!(status.source, AgentAuthSource::Environment);
        let login = account.auth.login_capabilities().launch_login.unwrap();
        assert_eq!(
            error_code(login.launch_login().await.unwrap_err()),
            Code::OPERATION_UNSUPPORTED
        );

        let config = AntigravityConfig::new(environment(
            &binary,
            Some("oauth-business"),
            Some("test-key"),
        ));
        let env = child_environment(&config, &Default::default()).unwrap();
        assert!(!env.contains_key("GEMINI_API_KEY"));
        assert_eq!(env["AGY_CLI_DISABLE_AUTO_UPDATE"].as_deref(), Some("true"));
        let login_env = antigravity_login_environment(&config).unwrap();
        assert!(!login_env.contains_key(std::ffi::OsStr::new("DISPLAY")));
        assert!(!login_env.contains_key(std::ffi::OsStr::new("WAYLAND_DISPLAY")));
    })
    .await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn fences_unfinished_model_and_headless_auth_probes_across_successful_login() {
    bounded(async {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("agy");
        executable(&binary, include_str!("fixtures/account-login.sh"));
        let config = AntigravityConfig::new(environment(&binary, None, None));
        let account = AntigravityAccount::new(config, logger(root.path()));
        let before = tokio::task::spawn_local({
            let catalog = account.catalog.clone();
            async move { catalog.snapshot(catalog_request(false, false)).await }
        });
        let old_auth = tokio::task::spawn_local({
            let auth = account.auth.clone();
            async move { auth.status(CancellationToken::new()).await }
        });
        for marker in ["models-started", "auth-started"] {
            while !fs::try_exists(root.path().join(marker)).await.unwrap() {
                sleep(Duration::from_millis(5)).await;
            }
        }
        let login = account.auth.login_capabilities();
        let launch = login.launch_login.unwrap();
        let complete = login.complete_login.unwrap();
        let status = login.login_status.unwrap();
        let session_id = launch.launch_login().await.unwrap().session_id;
        complete
            .complete_login(&session_id, "synthetic-code")
            .await
            .unwrap();
        loop {
            match status.login_status(Some(&session_id)).await.unwrap() {
                AgentAuthLoginStatus::Running { .. } => sleep(Duration::from_millis(5)).await,
                AgentAuthLoginStatus::Succeeded { .. } => break,
                outcome => panic!("unexpected login outcome: {outcome:?}"),
            }
        }
        let snapshot = account
            .catalog
            .snapshot(catalog_request(false, false))
            .await
            .unwrap();
        assert_eq!(
            snapshot
                .models
                .iter()
                .map(|model| model.value.as_str())
                .collect::<Vec<_>>(),
            ["default", "new-model"]
        );
        assert!(
            account
                .auth
                .status(CancellationToken::new())
                .await
                .unwrap()
                .authenticated
        );
        fs::write(root.path().join("release"), "").await.unwrap();
        assert!(!old_auth.await.unwrap().unwrap().authenticated);
        before.await.unwrap().unwrap();
        launch.launch_login().await.unwrap();
        assert!(
            account
                .auth
                .status(CancellationToken::new())
                .await
                .unwrap()
                .authenticated
        );
        account.stop();
    })
    .await;
}
