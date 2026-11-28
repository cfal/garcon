//! Ports `agents/antigravity/antigravity-auth.ts`.

use std::{
    cell::RefCell, collections::HashMap, ffi::OsString, process::Stdio, rc::Rc, time::Duration,
};

use garcon_agents_common::{
    acp::{
        client::{AcpClient, AcpClientOptions},
        protocol::garcon_initialize_params,
        transport::{AcpSpawnSpec, AcpTransport, AcpTransportOptions},
    },
    auth::cli_login_controller::CliLoginCommand,
    shared::shared_probe::{InFlightProbes, SharedProbe, shared_probe, wait_unless_aborted},
};
use garcon_contract::agent_execution::{AgentAuthSource, AgentAuthStatus};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    resources::ExecutorResult,
};
use garcon_js::trim;
use indexmap::IndexMap;
use tokio::{
    process::Command,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::{
    antigravity_models::{
        AntigravityCliResult, MODELS_TIMEOUT, antigravity_cli_failure, run_antigravity_models,
    },
    config::{AntigravityConfig, child_environment, classify_launch_error, integration_error},
};

const AUTHENTICATE_PROBE_TIMEOUT_MS: u64 = 10_000;
pub const MODEL_LISTING_REUSE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
struct Listing {
    result: AntigravityCliResult,
    listed_at: Instant,
}

impl Listing {
    fn recent(&self) -> bool {
        self.listed_at.elapsed() < MODEL_LISTING_REUSE
    }
}

pub(crate) struct AntigravityProbes {
    pub config: AntigravityConfig,
    authentication: InFlightProbes<bool>,
    models: InFlightProbes<AntigravityCliResult>,
    listings: Rc<RefCell<HashMap<String, Listing>>>,
    pub last_probed: RefCell<Option<AgentAuthStatus>>,
}

impl AntigravityProbes {
    pub fn new(config: AntigravityConfig) -> Self {
        Self {
            config,
            authentication: Rc::default(),
            models: Rc::default(),
            listings: Rc::default(),
            last_probed: RefCell::default(),
        }
    }

    fn models_key(&self) -> ExecutorResult<String> {
        Ok(serde_json::to_string(&(
            self.config.binary()?,
            self.config.auth_method()?,
            self.config.api_key()?,
        ))?)
    }

    fn refresh_listing(&self, key: &str) -> SharedProbe<AntigravityCliResult> {
        shared_probe(&self.models, key, || {
            let key = key.to_owned();
            let config = self.config.clone();
            let listings = self.listings.clone();
            Box::pin(async move {
                let result = run_antigravity_models(&config, MODELS_TIMEOUT).await;
                let mut listings = listings.borrow_mut();
                if let Ok(listing) = &result
                    && listing.exit_code == Some(0)
                {
                    listings.insert(
                        key,
                        Listing {
                            result: listing.clone(),
                            listed_at: Instant::now(),
                        },
                    );
                } else {
                    listings.remove(&key);
                }
                result
            })
        })
    }

    pub async fn list_models(&self) -> ExecutorResult<AntigravityCliResult> {
        let key = self.models_key()?;
        let listing = self.listings.borrow().get(&key).cloned();
        if let Some(listing) = listing {
            if !listing.recent() {
                drop(self.refresh_listing(&key));
            }
            return Ok(listing.result);
        }
        self.refresh_listing(&key).await
    }

    async fn run_models(&self, signal: &CancellationToken) -> ExecutorResult<AntigravityCliResult> {
        let key = self.models_key()?;
        let recent = self
            .listings
            .borrow()
            .get(&key)
            .filter(|listing| listing.recent())
            .cloned();
        let refreshed = self.refresh_listing(&key);
        if let Some(recent) = recent {
            return Ok(recent.result);
        }
        wait_unless_aborted(refreshed, Some(signal)).await
    }

    async fn authenticate(&self, signal: &CancellationToken) -> ExecutorResult<bool> {
        let key = serde_json::to_string(&(self.config.binary()?, self.config.auth_method()?))?;
        let config = self.config.clone();
        let probe = shared_probe(&self.authentication, &key, || {
            Box::pin(async move { authenticate_once(&config).await })
        });
        wait_unless_aborted(probe, Some(signal)).await
    }
}

async fn authenticate_once(config: &AntigravityConfig) -> ExecutorResult<bool> {
    let client = AcpClient::new(
        AcpTransport::new(AcpTransportOptions {
            request_timeout_ms: Some(AUTHENTICATE_PROBE_TIMEOUT_MS as f64),
            ..Default::default()
        }),
        AcpClientOptions {
            initialize: garcon_initialize_params(None)?,
            authenticate_method_id: Some(config.auth_method()?.into()),
        },
    );
    let binary = config.binary()?;
    let spec = AcpSpawnSpec {
        command: binary.clone(),
        args: vec!["acp".into()],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        env: login_environment(config)?
            .into_iter()
            .map(|(key, value)| (key, Some(value)))
            .collect(),
    };
    let result = client.connect(&spec).await;
    client.close();
    result
        .map(|result| result.authenticated_method_id.is_some())
        .map_err(|error| classify_launch_error(error, Some(&binary)))
}

fn signed_out(can_reauth: bool, detail: impl Into<String>) -> AgentAuthStatus {
    AgentAuthStatus {
        authenticated: false,
        can_reauth,
        label: String::new(),
        source: AgentAuthSource::None,
        detail: Some(detail.into()),
    }
}

pub(crate) async fn get_antigravity_auth_status(
    probes: &AntigravityProbes,
    signal: &CancellationToken,
    sign_in_running: bool,
    headless_authenticate: bool,
) -> ExecutorResult<AgentAuthStatus> {
    check_signal(signal)?;
    let config = &probes.config;
    let result: ExecutorResult<AgentAuthStatus> = async {
        let method = config.auth_method()?;
        let binary = config.binary()?;
        if method == "gemini-api-key" {
            if config.api_key()?.is_none() {
                return Ok(signed_out(false, "GEMINI_API_KEY is not set."));
            }
            check_version(config, &binary, signal).await?;
            check_signal(signal)?;
            return Ok(AgentAuthStatus {
                authenticated: true, can_reauth: false, label: "GEMINI_API_KEY".into(),
                source: AgentAuthSource::Environment, detail: None,
            });
        }
        if sign_in_running {
            return Ok(probes.last_probed.borrow().clone().unwrap_or_else(|| signed_out(true, "Sign-in in progress.")));
        }
        let can_reauth = method == "oauth-personal";
        if headless_authenticate {
            if !probes.authenticate(signal).await? {
                return Ok(AgentAuthStatus {
                    authenticated: false, can_reauth: false, label: String::new(), source: AgentAuthSource::Unknown,
                    detail: Some("The ACP agent does not advertise in-band authentication. Sign-in is checked when a session opens.".into()),
                });
            }
        } else {
            let result = probes.run_models(signal).await?;
            if result.exit_code != Some(0) {
                return Ok(signed_out(can_reauth, antigravity_cli_failure(&result)));
            }
        }
        Ok(AgentAuthStatus {
            authenticated: true, can_reauth, label: if can_reauth { "Google" } else { method }.into(),
            source: AgentAuthSource::Cli, detail: None,
        })
    }.await;
    match result {
        Ok(status) => Ok(status),
        Err(error) => {
            check_signal(signal)?;
            let unavailable = error
                .downcast_ref::<AgentIntegrationError>()
                .is_some_and(|error| error.code == Code::BINARY_NOT_FOUND);
            Ok(signed_out(
                !unavailable && config.auth_method().ok() == Some("oauth-personal"),
                error.to_string(),
            ))
        }
    }
}

async fn check_version(
    config: &AntigravityConfig,
    binary: &str,
    signal: &CancellationToken,
) -> ExecutorResult<()> {
    let mut child = Command::new(binary)
        .arg("--version")
        .env_clear()
        .envs(
            child_environment(config, &Default::default())?
                .into_iter()
                .filter_map(|(name, value)| Some((name, value?))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| classify_launch_error(error.into(), Some(binary)))?;
    let status = wait_unless_aborted(
        async {
            match timeout(
                Duration::from_millis(AUTHENTICATE_PROBE_TIMEOUT_MS),
                child.wait(),
            )
            .await
            {
                Ok(result) => Ok::<_, Box<dyn std::error::Error>>(Some(result?)),
                Err(_) => Ok(None),
            }
        },
        Some(signal),
    )
    .await?;
    if !status.is_some_and(|status| status.success()) {
        return Err("Antigravity CLI version check failed.".into());
    }
    Ok(())
}

pub fn antigravity_login_command(config: &AntigravityConfig) -> ExecutorResult<CliLoginCommand> {
    if config.auth_method()? != "oauth-personal" {
        return Err(integration_error(
            Code::OPERATION_UNSUPPORTED,
            "In-app Antigravity sign-in requires oauth-personal.",
        ));
    }
    Ok(CliLoginCommand {
        executable: config.binary()?.into(),
        args: vec!["acp".into(), "--login".into()],
    })
}

fn login_environment(config: &AntigravityConfig) -> ExecutorResult<IndexMap<String, String>> {
    Ok(child_environment(config, &Default::default())?
        .into_iter()
        .filter_map(|(name, value)| {
            (!matches!(name.as_str(), "DISPLAY" | "WAYLAND_DISPLAY")).then_some((name, value?))
        })
        .collect())
}

pub fn antigravity_login_environment(
    config: &AntigravityConfig,
) -> ExecutorResult<IndexMap<OsString, OsString>> {
    Ok(login_environment(config)?
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect())
}

pub fn validate_antigravity_login_code(code: &str) -> Option<&'static str> {
    if code
        .chars()
        .any(|value| trim(value.encode_utf8(&mut [0; 4])).is_empty())
    {
        return Some("Paste only the authorization code or the final page URL.");
    }
    if code.starts_with("http") && url::Url::parse(code).is_err() {
        return Some("The pasted URL is not valid.");
    }
    None
}

pub(crate) fn check_signal(signal: &CancellationToken) -> ExecutorResult<()> {
    if signal.is_cancelled() {
        return Err(garcon_base::errors::NamedError {
            name: "AbortError".into(),
            message: "The operation was aborted.".into(),
            code: None,
        }
        .into());
    }
    Ok(())
}
