//! Ports `server-agents/common/src/shared/single-query-control.ts`.

use std::error::Error;
use std::future::Future;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use garcon_base::errors::{ErrorInput, NamedError};
use garcon_base::executor_disconnect::as_agent_integration_error;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::resources::ExecutorResult;
use garcon_interface::services::AgentSingleQueryRequest;
use garcon_js::json::{Opaque, as_number};
use garcon_js::{math_round, number_to_string};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::auth::cli_login_controller::CliLoginSessionError;
use crate::errors::error_message;
use crate::execution::admission::check_signal;

pub async fn with_single_query_directory<T, F, Fut>(
    signal: &CancellationToken,
    operation: F,
) -> ExecutorResult<T>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = ExecutorResult<T>>,
{
    check_signal(Some(signal))?;
    let mut builder = tempfile::Builder::new();
    builder.prefix("garcon-single-query-");
    #[cfg(unix)]
    builder.permissions(std::fs::Permissions::from_mode(0o700));
    let directory = builder.tempdir_in(std::env::temp_dir())?;
    let result = match check_signal(Some(signal)) {
        Ok(()) => operation(directory.path().to_string_lossy().into_owned()).await,
        Err(error) => Err(error),
    };
    remove_directory(directory.path()).await?;
    result
}

// `rm(directory, { recursive: true, force: true })`: a directory that is
// already gone is no error, and its failure replaces the operation's outcome.
async fn remove_directory(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(path).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

// Runs a one-shot query in a disposable directory. A failure that is not
// already an integration error becomes a non-retryable provider failure.
pub async fn run_isolated_single_query<T, F, Fut>(
    request: &AgentSingleQueryRequest,
    operation: F,
) -> ExecutorResult<T>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = ExecutorResult<T>>,
{
    check_signal(Some(&request.signal))?;
    with_single_query_directory(&request.signal, operation)
        .await
        .map_err(|error| {
            if is_agent_integration_error(error.as_ref()) {
                return error;
            }
            AgentIntegrationError::new(
                AgentIntegrationErrorCode::PROVIDER_FAILURE,
                error_message(ErrorInput::Error(error.as_ref())),
                false,
                None,
            )
            .into()
        })
}

fn is_agent_integration_error(error: &(dyn Error + 'static)) -> bool {
    as_agent_integration_error(error).is_some() || error.is::<CliLoginSessionError>()
}

#[derive(Debug, Clone)]
pub struct SingleQueryRuntimeOptions {
    pub values: IndexMap<String, Opaque>,
    pub signal: CancellationToken,
}

pub fn single_query_runtime_options(
    request: &AgentSingleQueryRequest,
) -> SingleQueryRuntimeOptions {
    let mut values = IndexMap::new();
    if let Some(settings) = request.settings.values.as_object() {
        values.extend(
            settings
                .iter()
                .filter(|(key, _)| key.as_str() != "signal")
                .map(|(key, item)| (key.clone(), Opaque::from_value(item.clone()))),
        );
    }
    values.insert(
        "thinkingMode".to_owned(),
        Value::String(request.thinking_mode.as_str().to_owned()).into(),
    );
    if let Some(timeout_ms) = &request.timeout_ms {
        values.insert("timeoutMs".to_owned(), Value::from(timeout_ms.0).into());
    }
    SingleQueryRuntimeOptions {
        values,
        signal: request.signal.clone(),
    }
}

#[derive(Debug, Default)]
pub struct SingleQueryControlOptions<'a> {
    pub signal: Option<CancellationToken>,
    /// `timeoutMs` as the caller passed it: anything but a positive finite number means no timeout.
    pub timeout_ms: Option<&'a Value>,
}

pub async fn with_single_query_control<T, F, Fut>(
    options: SingleQueryControlOptions<'_>,
    operation: F,
) -> ExecutorResult<T>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: Future<Output = ExecutorResult<T>>,
{
    let controller = CancellationToken::new();
    let caller = options.signal;
    let timeout_ms = normalized_timeout_ms(options.timeout_ms);
    if caller.as_ref().is_some_and(CancellationToken::is_cancelled) {
        return Err(aborted().into());
    }

    let caller_cancelled = async {
        match &caller {
            Some(signal) => signal.cancelled().await,
            None => std::future::pending().await,
        }
    };
    let timeout = async {
        match timeout_ms {
            Some(timeout_ms) => sleep(sleep_duration(timeout_ms)).await,
            None => std::future::pending().await,
        }
    };
    let operation = operation(controller.clone());
    tokio::pin!(caller_cancelled, timeout, operation);

    // An abort settles the caller's wait before the operation can react to it,
    // as the abort listener registered first does in the original.
    tokio::select! {
        biased;
        _ = &mut caller_cancelled => {
            controller.cancel();
            Err(aborted().into())
        }
        _ = &mut timeout => {
            controller.cancel();
            let timeout_ms = timeout_ms.unwrap_or_default();
            Err(AgentIntegrationError::new(
                AgentIntegrationErrorCode::TIMEOUT,
                format!("Single query timed out after {}ms.", number_to_string(timeout_ms)),
                true,
                None,
            )
            .into())
        }
        result = &mut operation => result,
    }
}

fn normalized_timeout_ms(value: Option<&Value>) -> Option<f64> {
    let value = as_number(value?)?;
    (value.is_finite() && value > 0.0).then(|| math_round(value).max(1.0))
}

// A delay beyond a signed 32-bit integer of milliseconds fires after one
// millisecond, as the original's timer does.
fn sleep_duration(timeout_ms: f64) -> Duration {
    let timeout_ms = if timeout_ms > 2_147_483_647.0 {
        1.0
    } else {
        timeout_ms
    };
    Duration::try_from_secs_f64(timeout_ms / 1000.0).unwrap_or(Duration::MAX)
}

// The reason an aborted signal carries when nothing gave it one.
fn aborted() -> NamedError {
    NamedError {
        name: "AbortError".to_owned(),
        message: "The operation was aborted.".to_owned(),
        code: None,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::PathBuf;

    use garcon_base::executor_disconnect::{ExecutorSessionLostError, as_agent_call_error};
    use garcon_contract::agent_integration::AgentSettingsEnvelope;
    use garcon_contract::chat_modes::ThinkingMode;
    use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
    use garcon_js::Number;
    use serde_json::json;
    use tokio::fs;

    use super::*;

    fn is_aborted(error: &(dyn Error + 'static)) -> bool {
        error.downcast_ref::<NamedError>().is_some_and(|error| {
            error.name == "AbortError" && error.message == "The operation was aborted."
        })
    }

    fn request() -> AgentSingleQueryRequest {
        AgentSingleQueryRequest {
            prompt: "prompt".to_owned(),
            model: "model-a".to_owned(),
            thinking_mode: ThinkingMode::High,
            timeout_ms: Some(Number(42_000.0)),
            settings: AgentSettingsEnvelope {
                owner_id: "test".to_owned(),
                schema_version: 1,
                values: Opaque::from_value(
                    json!({ "providerOption": true, "thinkingMode": "low", "timeoutMs": 1 }),
                ),
            },
            endpoint: None,
            signal: CancellationToken::new(),
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum Outcome {
        Success,
        Failure,
        Cancelled,
        Timeout,
    }

    async fn cleans_the_provider_owned_temporary_directory_after(outcome: Outcome) {
        let controller = CancellationToken::new();
        let cancellation = controller.clone();
        let directory = RefCell::new(String::new());
        let timeout_ms = json!(1);
        let operation = with_single_query_directory(&controller, |created| {
            *directory.borrow_mut() = created.clone();
            let created = PathBuf::from(created);
            async move {
                assert!(fs::read_dir(&created).await?.next_entry().await?.is_none());
                #[cfg(unix)]
                assert_eq!(
                    fs::metadata(&created).await?.permissions().mode() & 0o777,
                    0o700
                );
                fs::write(created.join("synthetic-output"), "synthetic data").await?;
                match outcome {
                    Outcome::Cancelled => {
                        cancellation.cancel();
                        check_signal(Some(&cancellation))?;
                    }
                    Outcome::Failure => return Err("provider failed".into()),
                    Outcome::Timeout => {
                        return with_single_query_control(
                            SingleQueryControlOptions {
                                signal: None,
                                timeout_ms: Some(&timeout_ms),
                            },
                            |_| std::future::pending(),
                        )
                        .await
                        .map(|_: ()| "unreachable");
                    }
                    Outcome::Success => {}
                }
                Ok("answer")
            }
        });

        let result = operation.await;

        match outcome {
            Outcome::Success => assert_eq!(result.unwrap(), "answer"),
            Outcome::Failure => assert_eq!(result.unwrap_err().to_string(), "provider failed"),
            Outcome::Timeout => {
                assert_eq!(
                    result
                        .unwrap_err()
                        .downcast_ref::<AgentIntegrationError>()
                        .map(|error| error.code),
                    Some(AgentIntegrationErrorCode::TIMEOUT)
                );
            }
            Outcome::Cancelled => {
                assert!(is_aborted(result.unwrap_err().as_ref()));
            }
        }
        let directory = directory.into_inner();
        let removed = fs::metadata(&directory).await;
        assert_eq!(removed.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }

    #[tokio::test(start_paused = true)]
    async fn cleans_the_provider_owned_temporary_directory_after_success() {
        cleans_the_provider_owned_temporary_directory_after(Outcome::Success).await;
    }

    #[tokio::test(start_paused = true)]
    async fn cleans_the_provider_owned_temporary_directory_after_failure() {
        cleans_the_provider_owned_temporary_directory_after(Outcome::Failure).await;
    }

    #[tokio::test(start_paused = true)]
    async fn cleans_the_provider_owned_temporary_directory_after_cancelled() {
        cleans_the_provider_owned_temporary_directory_after(Outcome::Cancelled).await;
    }

    #[tokio::test(start_paused = true)]
    async fn cleans_the_provider_owned_temporary_directory_after_timeout() {
        cleans_the_provider_owned_temporary_directory_after(Outcome::Timeout).await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_aborted_signal_creates_no_directory() {
        let controller = CancellationToken::new();
        controller.cancel();
        let error =
            with_single_query_directory(&controller, |_| async { Ok::<_, Box<dyn Error>>(()) })
                .await
                .unwrap_err();
        assert!(is_aborted(error.as_ref()));
    }

    #[test]
    fn places_canonical_controls_after_provider_settings() {
        let request = request();

        let options = single_query_runtime_options(&request);

        assert_eq!(
            serde_json::to_string(&options.values).unwrap(),
            r#"{"providerOption":true,"thinkingMode":"high","timeoutMs":42000}"#
        );
        options.signal.cancel();
        assert!(request.signal.is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn propagates_caller_cancellation_to_the_running_operation() {
        let caller = CancellationToken::new();
        let running = with_single_query_control(
            SingleQueryControlOptions {
                signal: Some(caller.clone()),
                timeout_ms: None,
            },
            |signal| async move {
                signal.cancelled().await;
                check_signal(Some(&signal))?;
                Ok("unreachable")
            },
        );
        tokio::pin!(running);
        assert!(futures::poll!(running.as_mut()).is_pending());

        caller.cancel();

        let error = running.await.unwrap_err();
        assert!(is_aborted(error.as_ref()));
    }

    #[tokio::test(start_paused = true)]
    async fn terminates_the_operation_at_the_requested_timeout() {
        let timeout_ms = json!(1);
        let running = with_single_query_control(
            SingleQueryControlOptions {
                signal: None,
                timeout_ms: Some(&timeout_ms),
            },
            |_| std::future::pending::<ExecutorResult<()>>(),
        );

        let error = running.await.unwrap_err();
        let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(error.code, AgentIntegrationErrorCode::TIMEOUT);
        assert_eq!(error.message, "Single query timed out after 1ms.");
        assert!(error.retryable);
    }

    #[tokio::test(start_paused = true)]
    async fn cancels_the_operation_signal_before_reporting_timeout() {
        let timeout_ms = json!(5);
        let operation_signal = RefCell::new(None);
        let error = with_single_query_control(
            SingleQueryControlOptions {
                signal: None,
                timeout_ms: Some(&timeout_ms),
            },
            |signal| {
                operation_signal.replace(Some(signal));
                std::future::pending::<ExecutorResult<()>>()
            },
        )
        .await
        .unwrap_err();
        assert!(operation_signal.into_inner().unwrap().is_cancelled());
        assert_eq!(
            error
                .downcast_ref::<AgentIntegrationError>()
                .map(|error| error.code),
            Some(AgentIntegrationErrorCode::TIMEOUT)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_isolated_query_keeps_integration_errors_and_wraps_the_rest() {
        let failure =
            AgentIntegrationError::new(AgentIntegrationErrorCode::TIMEOUT, "Timed out", true, None);
        let kept = run_isolated_single_query(&request(), |_| async {
            Err::<(), _>(failure.clone().into())
        })
        .await
        .unwrap_err();
        assert_eq!(kept.downcast_ref::<AgentIntegrationError>(), Some(&failure));

        // Each subclass passes as the integration error it extends.
        let call = AgentCallError::new(AgentDeliveryOutcome::Rejected, "Refused");
        let kept = run_isolated_single_query(&request(), {
            let call = call.clone();
            |_| async move { Err::<(), _>(call.into()) }
        })
        .await
        .unwrap_err();
        assert_eq!(as_agent_call_error(kept.as_ref()), Some(&call));
        let lost = ExecutorSessionLostError::new(AgentDeliveryOutcome::Unknown, "Lost");
        let kept = run_isolated_single_query(&request(), {
            let lost = lost.clone();
            |_| async move { Err::<(), _>(lost.into()) }
        })
        .await
        .unwrap_err();
        assert_eq!(
            as_agent_call_error(kept.as_ref()).map(|error| error.outcome),
            Some(AgentDeliveryOutcome::Unknown)
        );
        let kept = run_isolated_single_query(&request(), |_| async {
            Err::<(), _>(CliLoginSessionError::new("Login session not found").into())
        })
        .await
        .unwrap_err();
        assert!(kept.is::<CliLoginSessionError>());
        assert_eq!(kept.to_string(), "Login session not found");

        let wrapped = run_isolated_single_query(&request(), |_| async {
            Err::<(), _>("process exited".into())
        })
        .await
        .unwrap_err();
        let wrapped = wrapped.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(wrapped.code, AgentIntegrationErrorCode::PROVIDER_FAILURE);
        assert_eq!(wrapped.message, "process exited");
        assert!(!wrapped.retryable);
    }

    #[tokio::test(start_paused = true)]
    async fn an_aborted_request_stops_before_a_directory_is_created() {
        let request = request();
        request.signal.cancel();
        let error = run_isolated_single_query(&request, |_| async { Ok::<_, Box<dyn Error>>(()) })
            .await
            .unwrap_err();
        assert!(is_aborted(error.as_ref()));
    }
}
