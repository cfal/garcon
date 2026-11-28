//! Ports `server-agents/opencode/src/agents/opencode/project-path.ts`.

use std::{error::Error, rc::Rc};

use async_trait::async_trait;
use futures::FutureExt;
use garcon_agents_common::execution::project_path_adapter::PrepareProjectPathUpdate;
use garcon_base::{
    errors::{ErrorInput, error_message},
    executor_disconnect::as_agent_call_error,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    execution::AgentProjectPathUpdatePreparation,
    resources::ExecutorResult,
    transcript::{AgentChatReference, AgentNativeSessionRef},
};
use garcon_js::OptionalNullable;

use super::{request_control::OpenCodeTimeoutError, sdk_result::OpenCodeSdkResultError};
use crate::js::{AbortSignal, error_of};

// OpenCode 1.18.34 flattens mismatch and missing-session errors into fixed messages.
// https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/server/routes/instance/httpapi/handlers/control-plane.ts#L30-L36
const DESTINATION_PROJECT_MISMATCH: &str = "Destination directory belongs to another project";
const SESSION_NOT_FOUND_PREFIX: &str = "Session not found:";

#[async_trait(?Send)]
pub trait OpenCodeProjectPathRuntime {
    async fn move_session(
        &self,
        agent_session_id: &str,
        directory: &str,
        signal: AbortSignal,
    ) -> ExecutorResult<()>;
}

pub fn create_open_code_project_path_updates(
    runtime: Rc<dyn OpenCodeProjectPathRuntime>,
    session_id: impl Fn(&AgentChatReference) -> Option<String> + 'static,
) -> Rc<PrepareProjectPathUpdate> {
    let session_id = Rc::new(session_id);
    Rc::new(move |request| {
        let runtime = runtime.clone();
        let session_id = session_id.clone();
        async move {
            let signal = AbortSignal::from_token(request.signal);
            signal.throw_if_aborted()?;
            let Some(session_id) = session_id(&request.chat).filter(|id| !id.is_empty()) else {
                return Ok(None);
            };
            runtime
                .move_session(&session_id, &request.next_project_path, signal.clone())
                .await
                .map_err(project_path_update_error)?;
            signal.throw_if_aborted()?;
            let preparation: Rc<dyn AgentProjectPathUpdatePreparation> =
                Rc::new(OpenCodeProjectPathPreparation {
                    runtime,
                    session_id,
                    previous_path: request.chat.project_path,
                });
            Ok(Some(preparation))
        }
        .boxed_local()
    })
}

struct OpenCodeProjectPathPreparation {
    runtime: Rc<dyn OpenCodeProjectPathRuntime>,
    session_id: String,
    previous_path: String,
}

#[async_trait(?Send)]
impl AgentProjectPathUpdatePreparation for OpenCodeProjectPathPreparation {
    fn native_session(&self) -> OptionalNullable<&AgentNativeSessionRef> {
        OptionalNullable::ABSENT
    }

    async fn commit(&self) -> ExecutorResult<()> {
        Ok(())
    }

    async fn rollback(&self) -> ExecutorResult<()> {
        self.runtime
            .move_session(&self.session_id, &self.previous_path, AbortSignal::new())
            .await
    }
}

fn project_path_update_error(error: Box<dyn Error>) -> Box<dyn Error> {
    if error_of::<AgentIntegrationError>(error.as_ref()).is_some()
        || as_agent_call_error(error.as_ref()).is_some()
    {
        return error;
    }
    if error_of::<OpenCodeTimeoutError>(error.as_ref()).is_some() {
        return AgentIntegrationError::new(
            Code::TIMEOUT,
            "OpenCode did not confirm the project path update",
            true,
            None,
        )
        .into();
    }
    if let Some(error) = error_of::<OpenCodeSdkResultError>(error.as_ref()) {
        let (code, message, retryable) = if error.message == DESTINATION_PROJECT_MISMATCH {
            (
                Code::PROJECT_PATH_DESTINATION_REJECTED,
                error.message.as_str(),
                false,
            )
        } else if error.message.starts_with(SESSION_NOT_FOUND_PREFIX) {
            (Code::SESSION_NOT_FOUND, error.message.as_str(), false)
        } else if error
            .status
            .is_some_and(|status| matches!(status, 404.0 | 405.0 | 501.0))
        {
            (
                Code::OPERATION_UNSUPPORTED,
                "This OpenCode version does not support project path updates",
                false,
            )
        } else {
            let code = if error.status.is_some_and(|status| status >= 500.0) {
                Code::UNAVAILABLE
            } else {
                Code::PROVIDER_FAILURE
            };
            (
                code,
                error.message.as_str(),
                error.status.is_none_or(|status| status >= 500.0),
            )
        };
        return AgentIntegrationError::new(code, message, retryable, None).into();
    }
    AgentIntegrationError::new(
        Code::UNAVAILABLE,
        error_message(ErrorInput::Error(error.as_ref()), None),
        true,
        None,
    )
    .into()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use garcon_contract::agent_integration::AgentSettingsEnvelope;
    use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
    use garcon_interface::execution::AgentProjectPathUpdateRequest;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::js::SharedError;

    #[derive(Default)]
    struct Moving(RefCell<Vec<(String, String)>>);

    #[async_trait(?Send)]
    impl OpenCodeProjectPathRuntime for Moving {
        async fn move_session(
            &self,
            session: &str,
            directory: &str,
            signal: AbortSignal,
        ) -> ExecutorResult<()> {
            signal.throw_if_aborted()?;
            self.0
                .borrow_mut()
                .push((session.to_owned(), directory.to_owned()));
            Ok(())
        }
    }

    fn fixture(session: Option<&str>) -> AgentProjectPathUpdateRequest {
        AgentProjectPathUpdateRequest {
            chat: AgentChatReference {
                chat_id: "chat-1".to_owned(),
                agent_id: "opencode".to_owned(),
                agent_session_id: session.map(str::to_owned),
                project_path: "/repo-a".to_owned(),
                model: String::new(),
                native_session: None,
                carry_over_revision: String::new(),
                native_seed_receipt: None,
                settings: AgentSettingsEnvelope {
                    owner_id: "opencode".to_owned(),
                    schema_version: 1,
                    values: json!({}).into(),
                },
            },
            next_project_path: "/repo-b".to_owned(),
            signal: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn moves_the_provider_session_and_rolls_it_back_without_replacing_the_native_binding() {
        let runtime = Rc::new(Moving::default());
        let prepare = create_open_code_project_path_updates(runtime.clone(), |chat| {
            chat.agent_session_id.clone()
        });
        let request = fixture(Some("session-1"));
        let caller = request.signal.clone();
        let preparation = prepare(request)
            .await
            .expect("moved session")
            .expect("preparation");
        assert!(preparation.native_session().is_absent());
        preparation.commit().await.expect("commit is a no-op");
        caller.cancel();
        preparation
            .rollback()
            .await
            .expect("rollback has its own signal");
        assert_eq!(
            *runtime.0.borrow(),
            [
                ("session-1".to_owned(), "/repo-b".to_owned()),
                ("session-1".to_owned(), "/repo-a".to_owned())
            ]
        );
    }

    #[tokio::test]
    async fn updates_an_unstarted_chat_without_starting_opencode() {
        let runtime = Rc::new(Moving::default());
        let prepare = create_open_code_project_path_updates(runtime.clone(), |chat| {
            chat.agent_session_id.clone()
        });
        assert!(
            prepare(fixture(None))
                .await
                .expect("no move needed")
                .is_none()
        );
        assert!(runtime.0.borrow().is_empty());
    }

    fn classification(error: Box<dyn Error>) -> (Code, String, bool) {
        let error = project_path_update_error(error);
        let typed = error
            .downcast_ref::<AgentIntegrationError>()
            .expect("mapped integration error");
        (typed.code, typed.message.clone(), typed.retryable)
    }

    #[test]
    fn classifies_provider_destination_mismatch_without_retry() {
        let error = OpenCodeSdkResultError::new(DESTINATION_PROJECT_MISMATCH, Some(400.0));
        assert_eq!(
            classification(error.into()),
            (
                Code::PROJECT_PATH_DESTINATION_REJECTED,
                DESTINATION_PROJECT_MISMATCH.to_owned(),
                false
            )
        );
    }

    #[test]
    fn reports_move_timeouts_as_an_unknown_retryable_outcome() {
        let error = SharedError::new(OpenCodeTimeoutError::new("OpenCode session move", 10_000.0));
        assert_eq!(
            classification(error.into()),
            (
                Code::TIMEOUT,
                "OpenCode did not confirm the project path update".to_owned(),
                true
            )
        );
    }

    #[test]
    fn classifies_missing_sessions_and_missing_move_endpoints() {
        let missing = OpenCodeSdkResultError::new("Session not found: fixture", Some(400.0));
        assert_eq!(
            classification(missing.into()),
            (
                Code::SESSION_NOT_FOUND,
                "Session not found: fixture".to_owned(),
                false
            )
        );
        for status in [404.0, 405.0, 501.0] {
            let missing = OpenCodeSdkResultError::new("Not Found", Some(status));
            assert_eq!(
                classification(missing.into()),
                (
                    Code::OPERATION_UNSUPPORTED,
                    "This OpenCode version does not support project path updates".to_owned(),
                    false
                )
            );
        }
    }

    #[test]
    fn preserves_the_integration_error_and_its_agent_call_subclass_through_erasure() {
        let normal = AgentIntegrationError::new(Code::SESSION_BUSY, "fixture busy", false, None);
        let result = project_path_update_error(normal.clone().into());
        assert_eq!(
            result.downcast_ref::<AgentIntegrationError>(),
            Some(&normal)
        );
        let subclass = AgentCallError::with_code(
            AgentDeliveryOutcome::Rejected,
            "move refused",
            Code::SESSION_BUSY,
        );
        let result = project_path_update_error(subclass.into());
        assert_eq!(
            as_agent_call_error(result.as_ref()).map(|error| error.outcome),
            Some(AgentDeliveryOutcome::Rejected)
        );
    }
}
