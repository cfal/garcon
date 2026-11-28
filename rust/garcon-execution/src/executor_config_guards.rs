//! Admission guards for replacing or removing a configured executor.

use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_chats::{agent_ownership_journal::AgentOwnershipJournal, store::ChatRegistry};
use garcon_contract::{error_codes::ErrorCode, executors::effective_executor_id};

use crate::{executor_manager::ExecutorConfigGuards, types::ChatExecutionQueries};

pub fn executor_config_guards(
    chats: Rc<ChatRegistry>,
    execution: Rc<dyn ChatExecutionQueries>,
    ownership: Rc<AgentOwnershipJournal>,
) -> ExecutorConfigGuards {
    ExecutorConfigGuards {
        assert_idle: Rc::new(move |executor_id| {
            if chats.list_all_chats().iter().any(|(id, chat)| {
                effective_executor_id(chat.executor_id.as_deref()) == executor_id
                    && execution.owns_execution(id)
            }) {
                return Err(DomainError::new(
                    ErrorCode::EXECUTOR_IN_USE,
                    "Stop or finish this executor's active work before changing its connection.",
                    409,
                    false,
                )
                .into());
            }
            Ok(())
        }),
        assert_removable: Rc::new(move |executor_id| {
            if ownership.blocks_executor_removal(executor_id) {
                return Err(DomainError::new(
                    ErrorCode::EXECUTOR_IN_USE,
                    "An ownership change or chat deletion is pending on this executor. Try deleting it after that operation finishes.",
                    409,
                    true,
                ).into());
            }
            Ok(())
        }),
    }
}
