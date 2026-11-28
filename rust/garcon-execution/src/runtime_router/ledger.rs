use std::rc::Rc;

use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_transient_feed::ChatTransientControlAction,
};
use garcon_interface::{producer::AgentRunFailureDetail, resources::AgentPermissionResponseRef};
use garcon_ledger::{
    producer_lease::ProducerLease,
    service::{PermissionResolutionClaim, TranscriptLedgerService},
};

use crate::types::ExecutionOperationResult;

use super::{RouterPermissionClaim, RuntimeRouterLedger};

pub struct RuntimeTranscriptLedger(pub Rc<TranscriptLedgerService>);

struct PermissionClaim {
    ledger: Rc<TranscriptLedgerService>,
    claim: Rc<PermissionResolutionClaim>,
}

impl RouterPermissionClaim for PermissionClaim {
    fn response(&self) -> &AgentPermissionResponseRef {
        &self.claim.decision.response
    }

    fn abandon(self: Box<Self>) -> ExecutionOperationResult<()> {
        self.ledger.abandon_permission_resolution(&self.claim)
    }

    fn retire(self: Box<Self>) -> ExecutionOperationResult<()> {
        self.ledger.retire_permission_resolution(&self.claim);
        Ok(())
    }

    fn complete(
        self: Box<Self>,
        decision: PermissionDecisionPayload,
    ) -> ExecutionOperationResult<()> {
        self.ledger
            .complete_permission_resolution(&self.claim, decision)?;
        Ok(())
    }
}

impl RuntimeRouterLedger for RuntimeTranscriptLedger {
    fn active_chat_ids(&self) -> Vec<String> {
        self.0.active_chat_ids()
    }

    fn is_run_active(&self, chat_id: &str) -> bool {
        self.0.is_run_active(chat_id, None)
    }

    fn active_run_id(&self, chat_id: &str) -> Option<String> {
        self.0.active_run_id(chat_id)
    }

    fn open_producer(
        &self,
        chat_id: &str,
        agent_id: &str,
    ) -> ExecutionOperationResult<Rc<ProducerLease>> {
        self.0.open_producer(chat_id, agent_id)
    }

    fn begin_run(&self, chat_id: &str, turn_id: &str) -> ExecutionOperationResult<String> {
        self.0.begin_run(chat_id, Some(turn_id))
    }

    fn interrupt_run(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        self.0.interrupt_run(chat_id)?;
        Ok(())
    }

    fn fail_run(
        &self,
        chat_id: &str,
        run_id: &str,
        error: AgentRunFailureDetail,
    ) -> ExecutionOperationResult<()> {
        self.0.fail_run(chat_id, run_id, Some(error))?;
        Ok(())
    }

    fn claim_permission_resolution(
        &self,
        control: &ChatTransientControlAction,
    ) -> ExecutionOperationResult<Box<dyn RouterPermissionClaim>> {
        let claim = self.0.claim_permission_resolution(control)?;
        Ok(Box::new(PermissionClaim {
            ledger: self.0.clone(),
            claim,
        }))
    }

    fn take_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: &str,
    ) -> ExecutionOperationResult<()> {
        self.0.take_prepared_input(chat_id, Some(client_message_id));
        Ok(())
    }
}
