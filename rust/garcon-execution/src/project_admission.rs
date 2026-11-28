//! Rechecks the registered executor, path and owner after the project read.

use std::{future::Future, rc::Rc};

use async_trait::async_trait;
use garcon_base::{domain_error::DomainError, interactive_deadline::read_before_at};
use garcon_chats::store::ChatRegistry;
use garcon_contract::{
    error_codes::ErrorCode, executors::effective_executor_id, project_resolution::ProjectResolution,
};
use garcon_interface::resources::ExecutorCallOptions;
use garcon_js::{OptionalNullable, performance_now_ms};

use crate::{
    executor_manager::ExecutorManager,
    types::{ExecutionOperationResult, ProjectAdmissionPort},
};

pub struct ProjectAdmission {
    chats: Rc<ChatRegistry>,
    executors: Rc<ExecutorManager>,
}

impl ProjectAdmission {
    pub fn new(chats: Rc<ChatRegistry>, executors: Rc<ExecutorManager>) -> Self {
        Self { chats, executors }
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for ProjectAdmission {
    async fn assert_available(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<()> {
        assert_available(
            || {
                self.chats.get_chat(chat_id).map(|chat| ProjectBinding {
                    path: chat.project_path,
                    executor_id: chat.executor_id,
                    epoch: chat.agent_ownership_epoch,
                })
            },
            |path, executor, options| async move {
                self.executors
                    .inspect_project(path, executor.as_deref(), Some(options))
                    .await
            },
            deadline,
            performance_now_ms,
        )
        .await
    }
}

struct ProjectBinding {
    path: String,
    executor_id: OptionalNullable<String>,
    epoch: String,
}

async fn assert_available<F>(
    read_chat: impl Fn() -> Option<ProjectBinding>,
    inspect: impl FnOnce(String, OptionalNullable<String>, ExecutorCallOptions) -> F,
    deadline: Option<f64>,
    now: impl FnOnce() -> f64,
) -> ExecutionOperationResult<()>
where
    F: Future<Output = ExecutionOperationResult<ProjectResolution>>,
{
    let chat = read_chat().ok_or_else(|| {
        DomainError::new(
            ErrorCode::SESSION_NOT_FOUND,
            "Session not found",
            404,
            false,
        )
    })?;
    let resolution = inspect(
        chat.path.clone(),
        chat.executor_id.clone(),
        read_before_at(deadline, None, now()),
    )
    .await?;
    if !read_chat().is_some_and(|current| {
        effective_executor_id(current.executor_id.as_deref())
            == effective_executor_id(chat.executor_id.as_deref())
            && current.path == chat.path
            && current.epoch == chat.epoch
    }) {
        return Err(DomainError::new(
            ErrorCode::PROJECT_PATH_CHANGED,
            "The chat project changed",
            409,
            false,
        )
        .into());
    }
    if let ProjectResolution::Unavailable { reason } = resolution {
        return Err(DomainError::new_project_unavailable(&chat.path, reason).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
