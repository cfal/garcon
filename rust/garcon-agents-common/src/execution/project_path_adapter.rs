//! Ports `server-agents/common/src/execution/project-path-adapter.ts`.

use std::{cell::RefCell, error::Error, rc::Rc, time::Duration};

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_interface::{
    errors::{
        AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
    },
    execution::{
        AgentPrepareProjectPathUpdateRequest, AgentPreparedProjectPathUpdate,
        AgentProjectPathUpdatePreparation, AgentProjectPathUpdateRequest, AgentProjectPathUpdates,
    },
    resources::{
        AgentProjectPathPreparation, AgentProjectPathPreparationKind, AgentResourceScope,
        ExecutorCallOptions, ExecutorResult,
    },
};
use garcon_js::OptionalNullable;
use indexmap::IndexSet;
use tokio::{
    task::{JoinHandle, spawn_local},
    time::{Instant, sleep_until},
};

use super::{
    admission::check_options,
    resolve_endpoint::call_error,
    resource_table::{AgentResourceTable, stale},
};

const PREPARATION_LIMIT: usize = 64;
const PREPARATION_TIMEOUT: Duration = Duration::from_secs(30);

pub type PrepareProjectPathUpdate = dyn Fn(
    AgentProjectPathUpdateRequest,
) -> LocalBoxFuture<
    'static,
    ExecutorResult<Option<Rc<dyn AgentProjectPathUpdatePreparation>>>,
>;

struct Preparation {
    chat_id: String,
    value: RefCell<Option<Rc<dyn AgentProjectPathUpdatePreparation>>>,
    timer: RefCell<Option<JoinHandle<()>>>,
}

impl Preparation {
    fn clear_timer(&self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

impl Drop for Preparation {
    fn drop(&mut self) {
        self.clear_timer();
    }
}

struct ProjectPathUpdates {
    blocked: RefCell<IndexSet<String>>,
    preparations: Rc<AgentResourceTable<AgentProjectPathPreparationKind, Rc<Preparation>>>,
    prepare: Rc<PrepareProjectPathUpdate>,
    new_id: Rc<dyn Fn() -> String>,
}

pub fn create_agent_project_path_updates(
    scope: AgentResourceScope,
    prepare: Rc<PrepareProjectPathUpdate>,
    new_id: Rc<dyn Fn() -> String>,
) -> Rc<dyn AgentProjectPathUpdates> {
    Rc::new(ProjectPathUpdates {
        blocked: RefCell::default(),
        preparations: Rc::new(AgentResourceTable::new(
            scope,
            AgentProjectPathPreparationKind::ProjectPathPreparation,
            PREPARATION_LIMIT,
        )),
        prepare,
        new_id,
    })
}

#[async_trait(?Send)]
impl AgentProjectPathUpdates for ProjectPathUpdates {
    async fn prepare(
        &self,
        request: AgentPrepareProjectPathUpdateRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<AgentPreparedProjectPathUpdate>> {
        check_options(options.as_ref())?;
        let chat_id = request.chat.chat_id.clone();
        if self.blocked.borrow().contains(&chat_id) {
            return Err(AgentCallError::with_code(
                AgentDeliveryOutcome::Rejected,
                "Project path decision requires reconciliation",
                AgentIntegrationErrorCode::SESSION_BUSY,
            )
            .into());
        }
        if self.blocked.borrow().len() >= PREPARATION_LIMIT {
            return Err(AgentCallError::with_code(
                AgentDeliveryOutcome::NotDispatched,
                "Project path preparation budget exhausted",
                AgentIntegrationErrorCode::SESSION_BUSY,
            )
            .into());
        }
        let preparation = Rc::new(Preparation {
            chat_id: chat_id.clone(),
            value: RefCell::default(),
            timer: RefCell::default(),
        });
        let reference = self
            .preparations
            .add(preparation.clone(), self.new_id.as_ref())?;
        self.blocked.borrow_mut().insert(chat_id.clone());
        let value = (self.prepare)(AgentProjectPathUpdateRequest {
            chat: request.chat,
            next_project_path: request.next_project_path,
            signal: options
                .and_then(|options| options.signal)
                .unwrap_or_default(),
        })
        .await;
        let value = match value {
            Ok(Some(value)) => value,
            Ok(None) => {
                self.preparations.delete(&reference)?;
                self.blocked.borrow_mut().shift_remove(&chat_id);
                return Ok(None);
            }
            Err(error) => {
                self.preparations.delete(&reference)?;
                if is_definitive_refusal(error.as_ref()) {
                    self.blocked.borrow_mut().shift_remove(&chat_id);
                }
                return Err(error);
            }
        };
        let native_session = value.native_session();
        let native_session = if native_session.is_absent() {
            OptionalNullable::ABSENT
        } else {
            OptionalNullable::from(native_session.as_option().map(|session| (*session).clone()))
        };
        preparation.value.replace(Some(value));
        let id = reference.clone();
        let table = Rc::downgrade(&self.preparations);
        let deadline = Instant::now() + PREPARATION_TIMEOUT;
        // Expiry cannot undo an authoritative path decision with a lost acknowledgement.
        preparation.timer.replace(Some(spawn_local(async move {
            sleep_until(deadline).await;
            if let Some(table) = table.upgrade() {
                let _ = table.delete(&id);
            }
        })));
        Ok(Some(AgentPreparedProjectPathUpdate {
            preparation: reference,
            native_session,
        }))
    }

    async fn commit(
        &self,
        reference: AgentProjectPathPreparation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        check_options(options.as_ref())?;
        let (preparation, value) = self.take(&reference)?;
        value.commit().await?;
        self.blocked.borrow_mut().shift_remove(&preparation.chat_id);
        Ok(())
    }

    async fn rollback(
        &self,
        reference: AgentProjectPathPreparation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        check_options(options.as_ref())?;
        let (preparation, value) = self.take(&reference)?;
        value.rollback().await?;
        self.blocked.borrow_mut().shift_remove(&preparation.chat_id);
        Ok(())
    }
}

impl ProjectPathUpdates {
    fn take(
        &self,
        reference: &AgentProjectPathPreparation,
    ) -> ExecutorResult<(Rc<Preparation>, Rc<dyn AgentProjectPathUpdatePreparation>)> {
        let preparation = self.preparations.take(reference)?;
        preparation.clear_timer();
        let value = preparation
            .value
            .take()
            .ok_or_else(|| stale("Resource has retired"))?;
        Ok((preparation, value))
    }
}

fn is_definitive_refusal(error: &(dyn Error + 'static)) -> bool {
    if let Some(error) = call_error(error) {
        return error.outcome != AgentDeliveryOutcome::Unknown;
    }
    error
        .downcast_ref::<AgentIntegrationError>()
        .is_some_and(|error| {
            matches!(
                error.code,
                AgentIntegrationErrorCode::SESSION_BUSY
                    | AgentIntegrationErrorCode::SESSION_NOT_FOUND
                    | AgentIntegrationErrorCode::OPERATION_UNSUPPORTED
                    | AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
                    | AgentIntegrationErrorCode::PROJECT_PATH_DESTINATION_REJECTED
            )
        })
}

#[cfg(test)]
mod tests;
