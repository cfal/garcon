//! Ports `agents/antigravity/antigravity-account.ts`.

use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_agents_common::auth::cli_login_controller::{
    CliLoginController, CliLoginControllerOptions, CliLoginMode,
};
use garcon_contract::{
    agent_auth::{AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus},
    agent_execution::AgentAuthStatus,
};
use garcon_interface::{
    host::AgentLogger,
    resources::ExecutorResult,
    services::{
        AgentAuth, AgentAuthCompleteLogin, AgentAuthLaunchLogin, AgentAuthLoginCapabilities,
        AgentAuthLoginStatusReader, AgentCatalog,
    },
};
use tokio_util::sync::CancellationToken;

use crate::{
    antigravity_auth::{
        AntigravityProbes, antigravity_login_command, antigravity_login_environment,
        get_antigravity_auth_status, validate_antigravity_login_code,
    },
    antigravity_models::create_antigravity_catalog,
    config::{AntigravityConfig, classify_launch_error},
};

pub struct AntigravityAccount {
    pub catalog: Rc<dyn AgentCatalog>,
    pub auth: Rc<dyn AgentAuth>,
    login: CliLoginController,
}

impl AntigravityAccount {
    pub fn new(config: AntigravityConfig, logger: Rc<dyn AgentLogger>) -> Self {
        let probes = Rc::new(RefCell::new(Rc::new(AntigravityProbes::new(
            config.clone(),
        ))));
        let binary = Rc::new(RefCell::new(None));
        let mut login_options = CliLoginControllerOptions::new(
            {
                let config = config.clone();
                let binary = binary.clone();
                move || {
                    let command = antigravity_login_command(&config)?;
                    binary.replace(Some(command.executable.to_string_lossy().into_owned()));
                    Ok(command)
                }
            },
            CliLoginMode::BrowserCode,
            logger.clone(),
        );
        login_options.environment = Some(Rc::new({
            let config = config.clone();
            move || antigravity_login_environment(&config)
        }));
        login_options.validate_code = Some(Rc::new(|code| {
            validate_antigravity_login_code(code).map(str::to_owned)
        }));
        login_options.on_succeeded = Some(Rc::new({
            let probes = probes.clone();
            move || {
                probes.replace(Rc::new(AntigravityProbes::new(config.clone())));
            }
        }));
        let login = CliLoginController::new(login_options);
        let catalog = Rc::new(create_antigravity_catalog(
            Rc::new({
                let probes = probes.clone();
                move || {
                    let current = probes.borrow().clone();
                    Box::pin(async move { current.list_models().await })
                }
            }),
            logger,
        ));
        let auth = Rc::new(Auth {
            probes,
            login: Login {
                controller: login.clone(),
                binary,
            },
        });
        Self {
            catalog,
            auth,
            login,
        }
    }

    pub fn stop(&self) {
        self.login.stop();
    }
}

struct Auth {
    probes: Rc<RefCell<Rc<AntigravityProbes>>>,
    login: Login,
}

#[async_trait(?Send)]
impl AgentAuth for Auth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        let sign_in_running = matches!(
            self.login.controller.status(None),
            AgentAuthLoginStatus::Running { .. }
        );
        let current = self.probes.borrow().clone();
        let status = get_antigravity_auth_status(
            &current,
            &signal,
            sign_in_running,
            cfg!(target_os = "linux"),
        )
        .await?;
        if !sign_in_running {
            current.last_probed.replace(Some(status.clone()));
        }
        Ok(status)
    }

    fn login_capabilities(&self) -> AgentAuthLoginCapabilities {
        let login = Rc::new(self.login.clone());
        AgentAuthLoginCapabilities {
            launch_login: Some(login.clone()),
            complete_login: Some(login.clone()),
            login_status: Some(login),
        }
    }
}

#[derive(Clone)]
struct Login {
    controller: CliLoginController,
    binary: Rc<RefCell<Option<String>>>,
}

#[async_trait(?Send)]
impl AgentAuthLaunchLogin for Login {
    async fn launch_login(&self) -> ExecutorResult<AgentAuthLoginLaunchResult> {
        self.controller
            .launch()
            .await
            .map_err(|error| classify_launch_error(error, self.binary.borrow().as_deref()))
    }
}

#[async_trait(?Send)]
impl AgentAuthCompleteLogin for Login {
    async fn complete_login(
        &self,
        session_id: &str,
        code: &str,
    ) -> ExecutorResult<AgentAuthLoginCompleteResult> {
        self.controller.complete(session_id, code).await
    }
}

#[async_trait(?Send)]
impl AgentAuthLoginStatusReader for Login {
    async fn login_status(
        &self,
        expected_session_id: Option<&str>,
    ) -> ExecutorResult<AgentAuthLoginStatus> {
        Ok(self.controller.status(expected_session_id))
    }
}
