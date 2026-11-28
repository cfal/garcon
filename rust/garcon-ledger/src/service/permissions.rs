use std::rc::Rc;

use garcon_base::errors::NamedError;
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_transient_feed::ChatTransientControlAction,
};
use garcon_interface::{
    producer::{
        AgentPermissionResponseCapability, AgentProducerPermission, AgentRequestedPermission,
        AgentTerminalPermission,
    },
    resources::is_agent_resource_ref,
};
use indexmap::IndexMap;

use crate::{
    contracts::{
        LedgerPermissionLifecycle, LedgerPermissionTool, LedgerRow, LedgerRowData, TranscriptViewId,
    },
    errors::LedgerError,
    sqlite_operations::LedgerResult,
};

use super::{TranscriptCommitEvent, TranscriptLedgerService, producer::LedgerSyncListener};

#[derive(Debug, Clone)]
pub struct PermissionResolutionClaim {
    pub chat_id: String,
    pub view_id: TranscriptViewId,
    pub run_id: String,
    pub permission_occurrence_id: String,
    pub claim_id: String,
    pub decision: AgentPermissionResponseCapability,
}

impl PermissionResolutionClaim {
    pub(super) fn control(&self) -> RetiredPermissionControl {
        RetiredPermissionControl {
            chat_id: self.chat_id.clone(),
            view_id: self.view_id.clone(),
            run_id: self.run_id.clone(),
            permission_occurrence_id: self.permission_occurrence_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredPermissionControl {
    pub chat_id: String,
    pub view_id: TranscriptViewId,
    pub run_id: String,
    pub permission_occurrence_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionActionability {
    Claimed,
    Actionable,
}

#[derive(Debug, Clone)]
pub struct PermissionActionabilityChange {
    pub control: RetiredPermissionControl,
    pub actionability: PermissionActionability,
}

pub(super) enum PermissionChange {
    Requested(AgentPermissionResponseCapability),
    Terminal(String),
}

pub(super) fn provider_permission(
    permission: AgentProducerPermission,
) -> LedgerResult<(LedgerRowData, PermissionChange)> {
    Ok(match permission {
        AgentProducerPermission::Requested {
            lifecycle:
                AgentRequestedPermission::Requested {
                    permission_occurrence_id,
                    requested_tool,
                    options,
                    reason,
                },
            decision,
        } => {
            if decision.permission_occurrence_id != permission_occurrence_id
                || !is_agent_resource_ref(
                    &serde_json::to_value(&decision.response)?,
                    "permission-response",
                    None,
                )
            {
                return Err(NamedError {
                    name: "TypeError".into(),
                    message: "Permission response capability does not match its request occurrence"
                        .into(),
                    code: None,
                }
                .into());
            }
            (
                LedgerRowData::PermissionRequested {
                    lifecycle: LedgerPermissionLifecycle::Requested {
                        permission_occurrence_id,
                        requested_tool: LedgerPermissionTool::ToolUse(requested_tool),
                        options,
                        reason,
                    },
                },
                PermissionChange::Requested(decision),
            )
        }
        AgentProducerPermission::Terminal { lifecycle } => match lifecycle {
            AgentTerminalPermission::Cancelled {
                permission_occurrence_id,
                reason,
            } => (
                LedgerRowData::PermissionCancelled {
                    lifecycle: LedgerPermissionLifecycle::Cancelled {
                        permission_occurrence_id: permission_occurrence_id.clone(),
                        reason,
                    },
                },
                PermissionChange::Terminal(permission_occurrence_id),
            ),
            AgentTerminalPermission::Expired {
                permission_occurrence_id,
            } => (
                LedgerRowData::PermissionExpired {
                    lifecycle: LedgerPermissionLifecycle::Expired {
                        permission_occurrence_id: permission_occurrence_id.clone(),
                    },
                },
                PermissionChange::Terminal(permission_occurrence_id),
            ),
        },
    })
}

struct ActivePermission {
    view_id: TranscriptViewId,
    run_id: String,
    decision: AgentPermissionResponseCapability,
    claim_id: Option<String>,
}

#[derive(Default)]
pub(super) struct PermissionState {
    active: IndexMap<String, IndexMap<String, ActivePermission>>,
    claims: IndexMap<String, Rc<PermissionResolutionClaim>>,
}

impl PermissionState {
    pub(super) fn apply(
        &mut self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        run_id: &str,
        active_run: Option<&str>,
        change: PermissionChange,
    ) -> Option<String> {
        match change {
            PermissionChange::Requested(decision) => {
                if active_run != Some(run_id) {
                    return None;
                }
                self.active.entry(chat_id.into()).or_default().insert(
                    decision.permission_occurrence_id.clone(),
                    ActivePermission {
                        view_id: view_id.clone(),
                        run_id: run_id.into(),
                        decision,
                        claim_id: None,
                    },
                );
            }
            PermissionChange::Terminal(occurrence) => {
                self.remove_permission_if(chat_id, &occurrence, |permission| {
                    permission.run_id == run_id
                });
            }
        }
        Some(run_id.into())
    }

    pub(super) fn claim(
        &mut self,
        action: &ChatTransientControlAction,
        server_instance_id: &str,
        active_run: Option<&str>,
        current_view: impl FnOnce() -> LedgerResult<Option<TranscriptViewId>>,
        create_claim_id: impl FnOnce() -> String,
    ) -> LedgerResult<Rc<PermissionResolutionClaim>> {
        if action.server_instance_id != server_instance_id || active_run != Some(&action.run_id) {
            return Err(LedgerError::PermissionNotActionable.into());
        }
        let permission = self
            .active
            .get_mut(&action.chat_id)
            .and_then(|permissions| permissions.get_mut(&action.permission_occurrence_id))
            .filter(|permission| {
                permission.run_id == action.run_id && permission.claim_id.is_none()
            })
            .ok_or(LedgerError::PermissionNotActionable)?;
        let view_id = current_view()?.ok_or(LedgerError::PermissionNotActionable)?;
        let claim_id = create_claim_id();
        let claim = Rc::new(PermissionResolutionClaim {
            chat_id: action.chat_id.clone(),
            view_id,
            run_id: action.run_id.clone(),
            permission_occurrence_id: action.permission_occurrence_id.clone(),
            claim_id: claim_id.clone(),
            decision: permission.decision.clone(),
        });
        permission.claim_id = Some(claim_id.clone());
        self.claims.insert(claim_id, claim.clone());
        Ok(claim)
    }

    pub(super) fn begin_completion(
        &mut self,
        claim: &Rc<PermissionResolutionClaim>,
        active_run: Option<&str>,
        current_view: Option<&TranscriptViewId>,
    ) -> LedgerResult<()> {
        if !self.knows_claim(claim)
            || active_run != Some(&claim.run_id)
            || current_view != Some(&claim.view_id)
            || !self
                .active
                .get(&claim.chat_id)
                .and_then(|permissions| permissions.get(&claim.permission_occurrence_id))
                .is_some_and(|permission| {
                    permission.claim_id.as_deref() == Some(&claim.claim_id)
                        && permission.run_id == claim.run_id
                })
        {
            return Err(LedgerError::PermissionNotActionable.into());
        }
        self.claims.shift_remove(&claim.claim_id);
        Ok(())
    }

    pub(super) fn finish_completion(&mut self, claim: &PermissionResolutionClaim) {
        self.remove_permission_if(
            &claim.chat_id,
            &claim.permission_occurrence_id,
            |permission| permission.claim_id.as_deref() == Some(&claim.claim_id),
        );
    }

    pub(super) fn abandon(
        &mut self,
        claim: &Rc<PermissionResolutionClaim>,
        active_run: Option<&str>,
        current_view: impl FnOnce() -> LedgerResult<Option<TranscriptViewId>>,
    ) -> LedgerResult<bool> {
        if !self.knows_claim(claim) {
            return Ok(false);
        }
        self.claims.shift_remove(&claim.claim_id);
        let Some(permission) = self
            .active
            .get_mut(&claim.chat_id)
            .and_then(|permissions| permissions.get_mut(&claim.permission_occurrence_id))
        else {
            return Ok(false);
        };
        if permission.claim_id.as_deref() != Some(&claim.claim_id)
            || active_run != Some(&claim.run_id)
            || current_view()?.as_ref() != Some(&claim.view_id)
        {
            return Ok(false);
        }
        permission.claim_id = None;
        Ok(true)
    }

    pub(super) fn retire(&mut self, claim: &Rc<PermissionResolutionClaim>) -> bool {
        if !self.knows_claim(claim) {
            return false;
        }
        self.claims.shift_remove(&claim.claim_id);
        self.remove_permission_if(
            &claim.chat_id,
            &claim.permission_occurrence_id,
            |permission| permission.claim_id.as_deref() == Some(&claim.claim_id),
        )
    }

    pub(super) fn controls_for_run(
        &self,
        chat_id: &str,
        run_id: &str,
    ) -> Vec<RetiredPermissionControl> {
        self.active
            .get(chat_id)
            .into_iter()
            .flatten()
            .filter(|(_, permission)| permission.run_id == run_id)
            .map(|(occurrence, permission)| RetiredPermissionControl {
                chat_id: chat_id.into(),
                view_id: permission.view_id.clone(),
                run_id: run_id.into(),
                permission_occurrence_id: occurrence.clone(),
            })
            .collect()
    }

    pub(super) fn clear_chat(&mut self, chat_id: &str) {
        self.active.shift_remove(chat_id);
        self.claims.retain(|_, claim| claim.chat_id != chat_id);
    }

    pub(super) fn clear_run(&mut self, chat_id: &str, run_id: &str) {
        if let Some(permissions) = self.active.get_mut(chat_id) {
            permissions.retain(|_, permission| {
                if permission.run_id != run_id {
                    return true;
                }
                if let Some(claim_id) = &permission.claim_id {
                    self.claims.shift_remove(claim_id);
                }
                false
            });
            if permissions.is_empty() {
                self.active.shift_remove(chat_id);
            }
        }
    }

    fn knows_claim(&self, claim: &Rc<PermissionResolutionClaim>) -> bool {
        self.claims
            .get(&claim.claim_id)
            .is_some_and(|expected| Rc::ptr_eq(expected, claim))
    }

    fn remove_permission_if(
        &mut self,
        chat_id: &str,
        occurrence: &str,
        matches: impl FnOnce(&ActivePermission) -> bool,
    ) -> bool {
        let Some(permissions) = self.active.get_mut(chat_id) else {
            return false;
        };
        if !permissions.get(occurrence).is_some_and(matches) {
            return false;
        }
        if let Some(permission) = permissions.shift_remove(occurrence)
            && let Some(claim_id) = permission.claim_id
        {
            self.claims.shift_remove(&claim_id);
        }
        if permissions.is_empty() {
            self.active.shift_remove(chat_id);
        }
        true
    }
}

impl TranscriptLedgerService {
    pub fn subscribe_permission_retired(
        &self,
        listener: Rc<LedgerSyncListener<RetiredPermissionControl>>,
    ) -> Box<dyn Fn()> {
        self.producers.retired.subscribe(listener)
    }

    pub fn subscribe_permission_actionability_changed(
        &self,
        listener: Rc<LedgerSyncListener<PermissionActionabilityChange>>,
    ) -> Box<dyn Fn()> {
        self.producers.actionability.subscribe(listener)
    }

    pub fn claim_permission_resolution(
        &self,
        action: &ChatTransientControlAction,
    ) -> LedgerResult<Rc<PermissionResolutionClaim>> {
        let active_run = self.active_run_id(&action.chat_id);
        let claim = self.producers.permissions.borrow_mut().claim(
            action,
            &self.producers.server_instance_id,
            active_run.as_deref(),
            || self.current_view_id(&action.chat_id),
            || (self.producers.create_claim_id)(),
        )?;
        self.change_permission_actionability(&claim, PermissionActionability::Claimed);
        Ok(claim)
    }

    pub fn complete_permission_resolution(
        &self,
        claim: &Rc<PermissionResolutionClaim>,
        decision: PermissionDecisionPayload,
    ) -> LedgerResult<LedgerRow> {
        let current = self.current_view_id(&claim.chat_id)?;
        let active_run = self.active_run_id(&claim.chat_id);
        self.producers.permissions.borrow_mut().begin_completion(
            claim,
            active_run.as_deref(),
            current.as_ref(),
        )?;
        let row = self.append_one(
            &claim.chat_id,
            &claim.view_id,
            LedgerRowData::PermissionResolved {
                lifecycle: LedgerPermissionLifecycle::Resolved {
                    permission_occurrence_id: claim.permission_occurrence_id.clone(),
                    decision,
                },
            },
        )?;
        self.producers
            .permissions
            .borrow_mut()
            .finish_completion(claim);
        self.notifications
            .notify(TranscriptCommitEvent::Permission {
                chat_id: claim.chat_id.clone(),
                view_id: claim.view_id.clone(),
                run_id: None,
                row: Box::new(row.clone()),
            });
        Ok(row)
    }

    pub fn abandon_permission_resolution(
        &self,
        claim: &Rc<PermissionResolutionClaim>,
    ) -> LedgerResult<()> {
        let active_run = self.active_run_id(&claim.chat_id);
        let restored = self.producers.permissions.borrow_mut().abandon(
            claim,
            active_run.as_deref(),
            || self.current_view_id(&claim.chat_id),
        )?;
        if restored {
            self.change_permission_actionability(claim, PermissionActionability::Actionable);
        }
        Ok(())
    }

    pub fn retire_permission_resolution(&self, claim: &Rc<PermissionResolutionClaim>) {
        if self.producers.permissions.borrow_mut().retire(claim) {
            let control = claim.control();
            let retired = self.producers.retired.clone();
            let notifications = self.notifications.clone();
            tokio::task::spawn_local(async move {
                for listener in retired.iter() {
                    if let Err(error) = listener(&control) {
                        notifications.report_error(error);
                    }
                }
            });
        }
    }

    fn change_permission_actionability(
        &self,
        claim: &PermissionResolutionClaim,
        actionability: PermissionActionability,
    ) {
        let event = PermissionActionabilityChange {
            control: claim.control(),
            actionability,
        };
        for listener in self.producers.actionability.iter() {
            if let Err(error) = listener(&event) {
                self.notifications.report_error(error);
            }
        }
    }

    fn current_view_id(&self, chat_id: &str) -> LedgerResult<Option<TranscriptViewId>> {
        Ok(self.store.current_view(chat_id)?.map(|view| view.view_id))
    }
}
