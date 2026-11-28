//! Restarts the existing execution and cleanup work when an executor returns.
//! Browser lifecycle publications still go through server event wiring.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::log::Logger;
use garcon_chats::{agent_ownership_journal::AgentOwnershipJournal, store::ChatRegistry};
use garcon_contract::executors::{ExecutorSnapshotAvailability, effective_executor_id};
use garcon_interface::execution_runtime::ExecutorAvailability;

use crate::{
    chat_execution_coordinator::ChatExecutionCoordinator,
    control_state::{StoredChatExecutionControlState, has_pending_turn_input},
    executor_manager::ExecutorManager,
    types::ExecutionOperationResult,
};

pub trait ExecutorAvailabilitySessions {
    fn execution_session_lost(&self, executor_id: &str);
    fn execution_session_resumed(&self, executor_id: &str);
}

pub trait ExecutorAvailabilityChats {
    fn list_chat_ids(&self) -> Vec<String>;
    fn chat_executor_id(&self, chat_id: &str) -> Option<String>;
}

impl ExecutorAvailabilityChats for ChatRegistry {
    fn list_chat_ids(&self) -> Vec<String> {
        Self::list_chat_ids(self)
            .into_iter()
            .map(|id| id.to_string())
            .collect()
    }

    fn chat_executor_id(&self, chat_id: &str) -> Option<String> {
        self.get_chat(chat_id)
            .map(|chat| effective_executor_id(chat.executor_id.as_deref()))
    }
}

#[async_trait(?Send)]
pub trait ExecutorAvailabilityOwnership {
    async fn retry_provider_cleanup(
        self: Rc<Self>,
        executor_id: &str,
    ) -> ExecutionOperationResult<()>;
}

#[async_trait(?Send)]
impl ExecutorAvailabilityOwnership for AgentOwnershipJournal {
    async fn retry_provider_cleanup(
        self: Rc<Self>,
        executor_id: &str,
    ) -> ExecutionOperationResult<()> {
        Self::retry_provider_cleanup(&self, executor_id).await
    }
}

#[async_trait(?Send)]
pub trait ExecutorAvailabilityQueue {
    async fn read_chat_execution_control(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    fn retry_queued_steers(&self, chat_id: &str) -> ExecutionOperationResult<()>;
    async fn trigger_drain(&self, chat_id: &str) -> ExecutionOperationResult<()>;
}

#[async_trait(?Send)]
impl ExecutorAvailabilityQueue for ChatExecutionCoordinator {
    async fn read_chat_execution_control(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        Self::read_chat_execution_control(self, chat_id).await
    }

    fn retry_queued_steers(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        Self::retry_queued_steers(self, chat_id)
    }

    async fn trigger_drain(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        Self::trigger_drain(self, chat_id).await
    }
}

pub struct ExecutorAvailabilityWiring {
    pub executors: Rc<ExecutorManager>,
    pub sessions: Rc<dyn ExecutorAvailabilitySessions>,
    pub chats: Rc<dyn ExecutorAvailabilityChats>,
    pub ownership: Rc<dyn ExecutorAvailabilityOwnership>,
    pub queue: Rc<dyn ExecutorAvailabilityQueue>,
    pub publish_processing: Rc<dyn Fn(&str)>,
    pub logger: Rc<dyn Logger>,
}

pub fn wire_executor_availability(options: ExecutorAvailabilityWiring) -> Box<dyn Fn()> {
    let ExecutorAvailabilityWiring {
        executors,
        sessions,
        chats,
        ownership,
        queue,
        publish_processing,
        logger,
    } = options;
    let retry_provider_cleanup = Rc::new({
        let logger = logger.clone();
        move |executor_id: &str| {
            let id = executor_id.to_owned();
            let ownership = ownership.clone();
            let logger = logger.clone();
            tokio::task::spawn_local(async move {
                if let Err(error) = ownership.retry_provider_cleanup(&id).await {
                    logger.warn(&format!("Executor native cleanup failed: {id} {error}"));
                }
            });
        }
    });
    let off = executors.on_availability_changed({
        let retry_provider_cleanup = retry_provider_cleanup.clone();
        Rc::new(move |executor_id, availability| {
            if matches!(
                availability,
                ExecutorAvailability::Reconnecting | ExecutorAvailability::Ready
            ) {
                publish_processing(executor_id);
            }
            if availability == ExecutorAvailability::Offline {
                sessions.execution_session_lost(executor_id);
            }
            if availability == ExecutorAvailability::Ready {
                logger.info(&format!("Executor ready: {executor_id}"));
                sessions.execution_session_resumed(executor_id);
                retry_provider_cleanup(executor_id);
                for chat_id in chats.list_chat_ids() {
                    if effective_executor_id(chats.chat_executor_id(&chat_id).as_deref())
                        != executor_id
                    {
                        continue;
                    }
                    let (executor_id, chats, queue, logger) = (
                        executor_id.to_owned(),
                        chats.clone(),
                        queue.clone(),
                        logger.clone(),
                    );
                    tokio::task::spawn_local(async move {
                        let result: ExecutionOperationResult<()> = async {
                            let control = queue.read_chat_execution_control(&chat_id).await?;
                            if chats.chat_executor_id(&chat_id).as_deref()
                                == Some(executor_id.as_str())
                                && has_pending_turn_input(&control)
                            {
                                queue.retry_queued_steers(&chat_id)?;
                                queue.trigger_drain(&chat_id).await?;
                            }
                            Ok(())
                        }
                        .await;
                        if let Err(error) = result {
                            logger.warn(&format!("Executor queue drain failed: {error}"));
                        }
                    });
                }
            }
        })
    });
    for executor in executors.list() {
        if executor.availability == ExecutorSnapshotAvailability::Ready {
            retry_provider_cleanup(&executor.id);
        }
    }
    off
}
