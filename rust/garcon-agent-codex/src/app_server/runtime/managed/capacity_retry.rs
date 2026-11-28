use std::rc::Rc;

use serde_json::json;

use crate::{
    app_server::runtime_support::{has_terminal_pending_finish, humanize_codex_app_server_error},
    service_tier::CodexServiceTier,
};

use super::{
    CodexAppServerRuntime, CodexOperation, CodexSessionSource, CodexTurnRoutes, ExecutorResult,
    FinishSessionOptions, RunningStatus,
};

impl CodexAppServerRuntime {
    pub(super) fn schedule_capacity_retry(
        &self,
        source: Rc<CodexSessionSource>,
        operation: Rc<CodexOperation>,
        failure: &str,
    ) -> bool {
        if source.admitted_tier.get() != CodexServiceTier::Default {
            return false;
        }
        let retries = source.capacity_retry_count.get();
        let Some(delay) = self.0.capacity_retry_delays.get(retries).copied() else {
            return false;
        };
        source.capacity_retry_count.set(retries + 1);
        let generation = source.turn_attempt.get() + 1;
        source.turn_attempt.set(generation);
        source.routes.borrow_mut().finish_active_turn();
        source.status.set(RunningStatus::Running);

        let runtime = self.clone();
        let failure = failure.to_owned();
        tokio::task::spawn_local(async move {
            tokio::time::sleep(delay).await;
            let result = runtime
                .retry_capacity(&source, &operation, generation)
                .await;
            let failure = match result {
                Ok(true) => return,
                Ok(false) => failure,
                Err(error) => humanize_codex_app_server_error(error.as_ref()),
            };
            if runtime.can_apply_turn_attempt(&source, generation) {
                runtime.finish_session(
                    &source,
                    FinishSessionOptions {
                        failed_message: Some(failure),
                        ..Default::default()
                    },
                    Some(&operation),
                );
            }
        });
        true
    }

    async fn retry_capacity(
        &self,
        source: &CodexSessionSource,
        operation: &Rc<CodexOperation>,
        generation: u64,
    ) -> ExecutorResult<bool> {
        let _input = source.input_lane.lock().await;
        source
            .settings
            .with_delivery(async {
                if !self.can_apply_turn_attempt(source, generation)
                    || source.status.get() != RunningStatus::Running
                    || source.routes.borrow().active_turn_id().is_some()
                {
                    return Ok(true);
                }
                let confirmed = source.settings.confirmed();
                if source.settings.is_fenced()
                    || confirmed.service_tier != "default"
                    || confirmed.model != *source.admitted_model.borrow()
                {
                    return Ok(false);
                }

                source.deliveries.set(source.deliveries.get() + 1);
                source.routes.borrow_mut().expect_turn(operation.clone());
                let response = source
                    .client
                    .request(
                        "turn/start",
                        Some(&json!({
                            "threadId": source.thread_id,
                            "input": [],
                            "serviceTierForTurn": "default",
                        })),
                        None,
                    )
                    .await;
                source.deliveries.set(source.deliveries.get() - 1);
                let matched = if let Ok(response) = &response
                    && self.can_apply_turn_attempt(source, generation)
                    && source.status.get() == RunningStatus::Running
                {
                    response["turn"]["id"].as_str().map(|turn_id| {
                        CodexTurnRoutes::adopt_turn(&source.routes, turn_id, operation.clone());
                    })
                } else {
                    Some(())
                };
                self.flush_pending_finish(source);
                response?;
                matched.ok_or("Invalid Codex turn/start response id")?;
                Ok(true)
            })
            .await
    }

    pub(super) fn can_apply_turn_attempt(
        &self,
        source: &CodexSessionSource,
        generation: u64,
    ) -> bool {
        self.is_current(source)
            && matches!(
                source.status.get(),
                RunningStatus::Running | RunningStatus::Completing
            )
            && !has_terminal_pending_finish(
                source
                    .pending_finish
                    .borrow()
                    .as_ref()
                    .map(|pending| &pending.options),
            )
            && source.turn_attempt.get() == generation
    }
}
