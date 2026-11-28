use std::{process::ExitCode, rc::Rc};

use garcon_contract::executors::LOCAL_EXECUTOR_ID;
use garcon_controller::server::{LocalExecutorContext, run_native_with_local};
use garcon_executor::{Executor, ExecutorIntegrationOptions, ExecutorOptions};
use garcon_interface::{
    execution_runtime::ExecutionRuntimeApi, host::AgentResolveCredentialRequest,
    resources::ExecutorResult,
};

pub(crate) unsafe fn run(args: &[String]) -> ExitCode {
    let mut local = None;
    // SAFETY: the native binary runs this before creating threads.
    unsafe { run_native_with_local(args, |context| start_local(&mut local, context)) }
}

fn start_local(
    owner: &mut Option<Executor>,
    context: LocalExecutorContext<'_>,
) -> ExecutorResult<Rc<dyn ExecutionRuntimeApi>> {
    let executor = Executor::start(ExecutorOptions {
        executor_id: LOCAL_EXECUTOR_ID.into(),
        project_base_path: context.config.project_base_path.clone(),
        terminal_runtime_id: None,
        user_shell: Some(context.config.user_shell.clone()),
        child_environment: None,
        integrations: Some(ExecutorIntegrationOptions {
            workspace_dir: context.workspace_dir.to_string_lossy().into_owned(),
            resolve_credential: Rc::new(move |request| {
                let credentials = context.credentials.clone();
                Box::pin(async move {
                    credentials
                        .resolve_credential(AgentResolveCredentialRequest {
                            reference: request.reference,
                            signal: request.signal,
                        })
                        .await
                })
            }),
        }),
    })?;
    let api = executor.api();
    // The controller awaits dispose before the executor's synchronous drop.
    *owner = Some(executor);
    Ok(api)
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::Path};

    use garcon_controller::{
        config::{ConfigEnvironment, ServerConfig, parse_server_config},
        server::Controller,
    };
    use garcon_interface::execution_runtime::ExecutorAvailability;
    use tokio::{net::TcpListener, task::LocalSet};

    use super::*;

    fn config(root: &Path) -> ServerConfig {
        parse_server_config(
            &[
                "--port=0".into(),
                "--bind-address=0.0.0.0".into(),
                format!("--config-dir={}", root.join("config").display()),
                format!("--workspace-dir={}", root.join("workspace").display()),
                format!("--project-base-dir={}", root.display()),
            ],
            &ConfigEnvironment {
                variables: &BTreeMap::new(),
                server_root: root.to_str().unwrap(),
                process_home: root.to_str().unwrap(),
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn native_composition_starts_and_disposes_local_with_the_direct_roster() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let mut owner = None;
                let controller = Controller::start_with_local(config(root.path()), |context| {
                    start_local(&mut owner, context)
                })
                .await
                .unwrap();
                let local = controller.local();
                assert_eq!(local.id(), LOCAL_EXECUTOR_ID);
                assert_eq!(local.availability(), ExecutorAvailability::Ready);
                let info = local.get_info(None).await.unwrap();
                let direct: Vec<_> = info
                    .integration_ids
                    .iter()
                    .filter(|id| id.starts_with("direct-"))
                    .map(String::as_str)
                    .collect();
                assert_eq!(
                    direct,
                    [
                        "direct-openai-responses-compatible",
                        "direct-openai-compatible",
                        "direct-anthropic-compatible",
                    ]
                );
                for id in direct {
                    let integration = local.get_agent_integration(id, None).await.unwrap();
                    let scope = integration.producers.scope().unwrap();
                    assert_eq!(scope.executor_id, LOCAL_EXECUTOR_ID);
                    assert_eq!(scope.instance_id, info.instance_id);
                }
                assert!(local.get_project_service(None).await.is_ok());
                assert!(local.get_terminal_service(None).await.is_ok());
                controller.shutdown().await.unwrap();
                assert_eq!(local.availability(), ExecutorAvailability::Disposed);
                assert!(local.get_project_service(None).await.is_err());
            })
            .await;
    }

    #[tokio::test]
    async fn native_composition_disposes_local_when_listener_binding_fails() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let mut config = config(root.path());
                let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
                config.port = listener.local_addr().unwrap().port();
                let mut owner = None;
                let result = Controller::start_with_local(config, |context| {
                    start_local(&mut owner, context)
                })
                .await;
                assert!(result.is_err());
                let local = owner.unwrap();
                assert_eq!(local.api().availability(), ExecutorAvailability::Disposed);
            })
            .await;
    }
}
