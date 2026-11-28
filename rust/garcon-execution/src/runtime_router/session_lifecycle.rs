//! Process-local ownership of the router's leases, native handles, and launch state.

use std::{cell::RefCell, rc::Rc};

use garcon_base::{
    domain_error::DomainError,
    executor_disconnect::{EXECUTOR_DISCONNECTED_BEFORE_START, EXECUTOR_DISCONNECTED_MID_TURN},
    log::Logger,
};
use garcon_contract::executors::effective_executor_id;
use garcon_interface::{execution_v5::AgentExecutionHandle, producer::AgentRunFailureDetail};
use garcon_ledger::producer_lease::ProducerLease;
use indexmap::{IndexMap, IndexSet};

use crate::{
    execution_aborts::ExecutionAborts,
    producer_bindings::ProducerBindings,
    session_types::require_chat_execution_config,
    types::{ExecutionOperationResult, LocalExecutionFuture},
};

use super::{RuntimeRouterChats, RuntimeRouterLedger};

type RunKey = (String, String);
pub type OwnershipTransferPending = dyn Fn(&str) -> bool;

struct ExecutorProducer {
    executor_id: String,
    lease: Rc<ProducerLease>,
}

#[derive(Clone)]
struct NativeExecution {
    agent_id: String,
    run_id: String,
    handle: AgentExecutionHandle,
}

pub struct RuntimeSessions {
    chats: Rc<dyn RuntimeRouterChats>,
    ledger: Rc<dyn RuntimeRouterLedger>,
    aborts: Rc<ExecutionAborts>,
    ownership_transfer_pending: Rc<OwnershipTransferPending>,
    logger: Rc<dyn Logger>,
    producers: RefCell<IndexMap<String, ExecutorProducer>>,
    executions: RefCell<IndexMap<String, NativeExecution>>,
    setting_up: RefCell<IndexMap<String, String>>,
    publications: RefCell<IndexMap<RunKey, Rc<ProducerBindings>>>,
    pending_aborts: RefCell<IndexSet<RunKey>>,
}

impl RuntimeSessions {
    pub fn new(
        chats: Rc<dyn RuntimeRouterChats>,
        ledger: Rc<dyn RuntimeRouterLedger>,
        aborts: Rc<ExecutionAborts>,
        ownership_transfer_pending: Rc<OwnershipTransferPending>,
        logger: Rc<dyn Logger>,
    ) -> Self {
        Self {
            chats,
            ledger,
            aborts,
            ownership_transfer_pending,
            logger,
            producers: RefCell::default(),
            executions: RefCell::default(),
            setting_up: RefCell::default(),
            publications: RefCell::default(),
            pending_aborts: RefCell::default(),
        }
    }

    pub fn producer(&self, chat_id: &str) -> ExecutionOperationResult<Rc<ProducerLease>> {
        if let Some(producer) = self.producers.borrow().get(chat_id)
            && !producer.lease.closed()
        {
            return Ok(producer.lease.clone());
        }
        if (self.ownership_transfer_pending)(chat_id) {
            return Err(DomainError::new_ownership_transfer_pending().into());
        }
        let entry = self.chats.get_chat(chat_id);
        require_chat_execution_config(chat_id, entry.as_ref().map(|entry| &entry.execution))?;
        // INFALLIBLE: a required configuration was found on this chat entry.
        let entry = entry.expect("valid configuration belongs to a chat");
        let lease = self.ledger.open_producer(chat_id, &entry.agent_id)?;
        self.producers.borrow_mut().insert(
            chat_id.into(),
            ExecutorProducer {
                executor_id: effective_executor_id(entry.execution.executor_id.as_deref()),
                lease: lease.clone(),
            },
        );
        Ok(lease)
    }

    pub fn reopen_producer(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        let current = self
            .producers
            .borrow()
            .get(chat_id)
            .map(|entry| entry.lease.clone());
        if let Some(lease) = current {
            lease.close()?;
        }
        self.producers.borrow_mut().shift_remove(chat_id);
        self.producer(chat_id)?;
        Ok(())
    }

    pub fn begin_run(
        &self,
        chat_id: &str,
        turn_id: &str,
        bindings: Rc<ProducerBindings>,
        on_started: impl FnOnce() -> Option<LocalExecutionFuture<'static>> + 'static,
    ) -> ExecutionOperationResult<String> {
        let run_id = self.ledger.begin_run(chat_id, turn_id)?;
        bindings.on_started(run_id.clone(), on_started);
        self.publications
            .borrow_mut()
            .insert(run_key(chat_id, &run_id), bindings);
        self.setting_up
            .borrow_mut()
            .insert(chat_id.into(), run_id.clone());
        Ok(run_id)
    }

    pub fn mark_launch_dispatched(&self, chat_id: &str, run_id: &str) {
        let mut setup = self.setting_up.borrow_mut();
        if setup.get(chat_id).is_some_and(|current| current == run_id) {
            setup.shift_remove(chat_id);
        }
    }

    pub fn retain_or_abort_handle(
        &self,
        chat_id: &str,
        agent_id: &str,
        run_id: &str,
        handle: AgentExecutionHandle,
    ) {
        if self
            .pending_aborts
            .borrow_mut()
            .shift_remove(&run_key(chat_id, run_id))
        {
            self.aborts
                .request(chat_id, agent_id, &handle, "interrupted launch");
            return;
        }
        if self.ledger.active_run_id(chat_id).as_deref() == Some(run_id) {
            self.executions.borrow_mut().insert(
                chat_id.into(),
                NativeExecution {
                    agent_id: agent_id.into(),
                    run_id: run_id.into(),
                    handle,
                },
            );
        }
    }

    pub fn abort_session(&self, chat_id: &str) -> ExecutionOperationResult<bool> {
        let Some(run_id) = self.ledger.active_run_id(chat_id) else {
            return Ok(false);
        };
        let active = self
            .executions
            .borrow()
            .get(chat_id)
            .filter(|active| active.run_id == run_id)
            .cloned();
        self.ledger.interrupt_run(chat_id)?;
        if let Some(active) = active {
            self.take_execution(chat_id, &run_id);
            self.aborts.request(
                chat_id,
                &active.agent_id,
                &active.handle,
                "accepted interruption",
            );
        } else {
            self.pending_aborts
                .borrow_mut()
                .insert(run_key(chat_id, &run_id));
        }
        Ok(true)
    }

    pub fn abort_publication(&self, chat_id: &str, run_id: &str) {
        if let Some(active) = self.take_execution(chat_id, run_id) {
            self.aborts.request(
                chat_id,
                &active.agent_id,
                &active.handle,
                "publication failure",
            );
        } else {
            self.pending_aborts
                .borrow_mut()
                .insert(run_key(chat_id, run_id));
        }
        self.forget_publication(chat_id, run_id);
    }

    pub fn run_terminal_committed(&self, chat_id: &str, run_id: &str) {
        self.forget_publication(chat_id, run_id);
        self.take_execution(chat_id, run_id);
    }

    pub fn execution_session_resumed(&self, executor_id: &str) {
        self.aborts.session_resumed(executor_id);
    }

    pub fn execution_session_lost(&self, executor_id: &str) {
        let runs: Vec<_> = self
            .ledger
            .active_chat_ids()
            .into_iter()
            .filter_map(|chat_id| {
                let entry = self.chats.get_chat(&chat_id);
                let executor = effective_executor_id(
                    entry
                        .as_ref()
                        .and_then(|chat| chat.execution.executor_id.as_deref()),
                );
                if executor != executor_id {
                    return None;
                }
                let run = self.ledger.active_run_id(&chat_id)?;
                Some((chat_id, run))
            })
            .collect();
        let leases: Vec<_> = self
            .producers
            .borrow()
            .iter()
            .filter(|(_, producer)| producer.executor_id == executor_id)
            .map(|(chat, producer)| (chat.clone(), producer.lease.clone()))
            .collect();
        self.executions
            .borrow_mut()
            .retain(|_, active| active.handle.scope.executor_id != executor_id);
        for (chat_id, run_id) in runs {
            self.pending_aborts
                .borrow_mut()
                .shift_remove(&run_key(&chat_id, &run_id));
            self.forget_publication(&chat_id, &run_id);
            let setting_up = self.setting_up.borrow().get(&chat_id) == Some(&run_id);
            let (code, message) = if setting_up {
                (
                    EXECUTOR_DISCONNECTED_BEFORE_START.code,
                    EXECUTOR_DISCONNECTED_BEFORE_START.message,
                )
            } else {
                ("OUTCOME_UNKNOWN", EXECUTOR_DISCONNECTED_MID_TURN)
            };
            if let Err(error) = self.ledger.fail_run(
                &chat_id,
                &run_id,
                AgentRunFailureDetail {
                    code: code.into(),
                    message: Some(message.into()),
                },
            ) {
                self.logger.warn(&format!(
                    "Unable to record executor loss ({executor_id}, {chat_id}): {error}"
                ));
            }
        }
        // A lease close clears its active run, so the terminal commit must come first.
        for (chat_id, lease) in leases {
            if let Err(error) = lease.close() {
                self.logger.warn(&format!(
                    "Unable to close lost-executor producer ({executor_id}, {chat_id}): {error}"
                ));
            }
            let mut producers = self.producers.borrow_mut();
            if producers
                .get(&chat_id)
                .is_some_and(|current| Rc::ptr_eq(&current.lease, &lease))
            {
                producers.shift_remove(&chat_id);
            }
        }
    }

    fn take_execution(&self, chat_id: &str, run_id: &str) -> Option<NativeExecution> {
        let mut executions = self.executions.borrow_mut();
        if executions
            .get(chat_id)
            .is_some_and(|active| active.run_id == run_id)
        {
            executions.shift_remove(chat_id)
        } else {
            None
        }
    }

    fn forget_publication(&self, chat_id: &str, run_id: &str) {
        if let Some(bindings) = self
            .publications
            .borrow_mut()
            .shift_remove(&run_key(chat_id, run_id))
        {
            bindings.forget_run(run_id);
        }
    }
}

fn run_key(chat_id: &str, run_id: &str) -> RunKey {
    (chat_id.into(), run_id.into())
}
