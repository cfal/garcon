use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::json;

use crate::{
    app_server::request_builders::{ThreadForkSource, build_thread_fork_params},
    service_tier::{assert_effective_tier, codex_service_tier},
};

use super::{
    CodexAppServerRuntime, CodexStartedSession, ExecutorResult, MaterializedThreadOptions,
    wait_for_materialized_thread,
};

impl CodexAppServerRuntime {
    pub async fn fork_session(
        &self,
        source: ThreadForkSource,
        env: Option<IndexMap<String, String>>,
    ) -> ExecutorResult<Option<CodexStartedSession>> {
        if source.agent_session_id.is_empty() {
            return Ok(None);
        }
        let runtime = self.clone();
        tokio::task::spawn_local(async move {
            let (client, events) =
                runtime.new_client(env.as_ref(), source.codex_config.as_ref())?;
            let forked = async {
                events.release()?;
                let result = client
                    .request(
                        "thread/fork",
                        Some(&build_thread_fork_params(&source)),
                        None,
                    )
                    .await?;
                let thread_id = result["thread"]["id"]
                    .as_str()
                    .ok_or("Invalid Codex thread response id")?;
                let params = json!({"threadId":thread_id});
                if let Err(error) = client
                    .request("thread/unsubscribe", Some(&params), None)
                    .await
                {
                    runtime.log_fork_error(
                        "Codex thread unsubscribe failed",
                        thread_id,
                        &error.to_string(),
                    );
                }
                if let Err(error) = assert_effective_tier(
                    codex_service_tier(source.speed),
                    result["serviceTier"].as_str(),
                    result["model"].as_str().unwrap_or("undefined"),
                ) {
                    // Archives only the unpublished child, not the source thread.
                    if let Err(cause) = client
                        .request(
                            "thread/archive",
                            Some(&params),
                            Some(runtime.0.settings_timeout),
                        )
                        .await
                    {
                        runtime.log_fork_error(
                            "Codex could not archive rejected fork",
                            thread_id,
                            &cause.to_string(),
                        );
                    }
                    return Err(error.into());
                }
                let native_path = wait_for_materialized_thread(
                    thread_id,
                    result["thread"]["path"].as_str(),
                    MaterializedThreadOptions {
                        timeout: runtime.0.materialization_timeout,
                        ..Default::default()
                    },
                )
                .await?;
                runtime.0.utility.clear_thread_list_caches();
                Ok(Some(CodexStartedSession {
                    agent_session_id: thread_id.into(),
                    native_path: Some(native_path),
                }))
            }
            .await;
            runtime.shutdown_client(&client).await;
            forked
        })
        .await?
    }

    fn log_fork_error(&self, message: &str, thread_id: &str, error: &str) {
        self.0.logger.warn(
            message,
            Some(&IndexMap::from([
                ("threadId".into(), Opaque::from_value(json!(thread_id))),
                ("error".into(), Opaque::from_value(json!(error))),
            ])),
        );
    }
}
