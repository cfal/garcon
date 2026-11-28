use garcon_base::errors::NamedError;

use crate::worker::{Executor, ExecutorOptions};

use super::*;

#[tokio::test]
async fn distinguishes_unknown_integration_from_cancellation_and_disposal() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let project = tempfile::tempdir().unwrap();
            let executor = Executor::start(ExecutorOptions {
                executor_id: "local".into(),
                project_base_path: project.path().to_str().unwrap().into(),
                terminal_runtime_id: None,
                user_shell: None,
                child_environment: None,
            })
            .unwrap();
            let api = executor.api();
            let signal = CancellationToken::new();
            let unknown = resolve_worker_integration(api.as_ref(), "missing", signal.clone())
                .await
                .err()
                .unwrap();
            let unknown = unknown.downcast_ref::<AgentCallError>().unwrap();
            assert_eq!(unknown.outcome, AgentDeliveryOutcome::NotDispatched);
            assert_eq!(
                unknown.code,
                AgentIntegrationErrorCode::OPERATION_UNSUPPORTED
            );
            assert_eq!(unknown.message, "Unknown integration");

            let cancelled = CancellationToken::new();
            cancelled.cancel();
            let error = resolve_worker_integration(api.as_ref(), "missing", cancelled)
                .await
                .err()
                .unwrap();
            let error = error.downcast_ref::<NamedError>().unwrap();
            assert_eq!(error.name, "AbortError");
            assert_eq!(error.message, "The operation was aborted.");

            api.dispose().await.unwrap();
            let error = resolve_worker_integration(api.as_ref(), "missing", signal)
                .await
                .err()
                .unwrap();
            let error = error.downcast_ref::<AgentCallError>().unwrap();
            assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
            assert_eq!(error.code, AgentIntegrationErrorCode::UNAVAILABLE);
            assert_eq!(error.message, "Executor is disposed");
        })
        .await;
}
