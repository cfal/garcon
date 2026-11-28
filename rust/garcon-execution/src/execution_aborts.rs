//! Keeps deferred aborts on the executor that owns the captured execution handle.

use std::{
    cell::RefCell,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_interface::execution_v5::AgentExecutionHandle;
use indexmap::IndexMap;

use crate::{
    directory::AgentDirectory,
    types::{ExecutionOperationResult, LocalExecutionFuture},
};

pub trait ExecutionAbortDirectory {
    fn is_ready(&self, executor_id: &str) -> bool;
    fn abort(
        &self,
        agent_id: &str,
        handle: &AgentExecutionHandle,
    ) -> ExecutionOperationResult<LocalExecutionFuture<'static, bool>>;
}

impl ExecutionAbortDirectory for AgentDirectory {
    fn is_ready(&self, executor_id: &str) -> bool {
        AgentDirectory::is_ready(self, Some(executor_id))
    }

    fn abort(
        &self,
        agent_id: &str,
        handle: &AgentExecutionHandle,
    ) -> ExecutionOperationResult<LocalExecutionFuture<'static, bool>> {
        let integration = self.require(agent_id, Some(&handle.scope.executor_id))?;
        let handle = handle.clone();
        Ok(Box::pin(async move {
            integration.execution.abort(handle, None).await
        }))
    }
}

struct DeferredAbort {
    agent_id: String,
    handle: AgentExecutionHandle,
}

pub struct ExecutionAborts {
    directory: Rc<dyn ExecutionAbortDirectory>,
    deferred: RefCell<IndexMap<String, DeferredAbort>>,
    logger: ScopedLogger,
}

impl ExecutionAborts {
    pub fn new(directory: Rc<dyn ExecutionAbortDirectory>) -> Self {
        Self {
            directory,
            deferred: RefCell::default(),
            logger: create_logger("agents:execution-aborts"),
        }
    }

    pub fn session_resumed(self: &Rc<Self>, executor_id: &str) {
        let chats: Vec<String> = self
            .deferred
            .borrow()
            .iter()
            .filter(|(_, deferred)| deferred.handle.scope.executor_id == executor_id)
            .map(|(chat, _)| chat.clone())
            .collect();
        for chat in chats {
            let deferred = self.deferred.borrow_mut().shift_remove(&chat);
            if let Some(deferred) = deferred {
                self.request(
                    &chat,
                    &deferred.agent_id,
                    &deferred.handle,
                    "executor reconnect",
                );
            }
        }
    }

    pub fn request(
        self: &Rc<Self>,
        chat_id: &str,
        agent_id: &str,
        handle: &AgentExecutionHandle,
        context: &str,
    ) {
        let mut work = match self.directory.abort(agent_id, handle) {
            Ok(work) => work,
            Err(error) => {
                self.failed(chat_id, agent_id, handle, context, error.as_ref());
                return;
            }
        };
        // Native abort begins inline; promise rejection observes readiness on the next turn.
        let first = work.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        if matches!(first, Poll::Ready(Ok(_))) {
            return;
        }
        let owner = self.clone();
        let (chat_id, agent_id, handle, context) = (
            chat_id.to_owned(),
            agent_id.to_owned(),
            handle.clone(),
            context.to_owned(),
        );
        tokio::task::spawn_local(async move {
            let result = match first {
                Poll::Ready(result) => result,
                Poll::Pending => work.await,
            };
            if let Err(error) = result {
                owner.failed(&chat_id, &agent_id, &handle, &context, error.as_ref());
            }
        });
    }

    fn failed(
        &self,
        chat_id: &str,
        agent_id: &str,
        handle: &AgentExecutionHandle,
        context: &str,
        error: &dyn std::error::Error,
    ) {
        if !self.directory.is_ready(&handle.scope.executor_id) {
            self.deferred.borrow_mut().insert(
                chat_id.into(),
                DeferredAbort {
                    agent_id: agent_id.into(),
                    handle: handle.clone(),
                },
            );
            return;
        }
        self.logger.warn(&format!(
            "Provider abort after {context} failed ({chat_id}): {error}"
        ));
    }
}
