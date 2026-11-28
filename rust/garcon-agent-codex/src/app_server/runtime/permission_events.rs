use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

use garcon_agents_common::execution::runtime_events::RuntimePermissionResponse;
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_modes::PermissionMode,
    chat_types::{PermissionExpiredMessage, ToolUseChatMessage},
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{
    Number,
    clock::{Clock, to_iso_string},
    json::{Opaque, as_number},
};
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::app_server::{
    approvals::{
        build_approval_message, build_approval_response, create_pending_approval,
        is_approval_request,
        registry::{
            CodexPendingApprovalRegistry, CodexTrackedApproval, add_pending_approval,
            cancel_pending_approvals, take_pending_approval,
        },
    },
    client::CodexAppServerClient,
    operation_routes::{CodexOperation, publish_permission_expired, publish_permission_requested},
    protocol::{JsonRpcId, JsonRpcServerRequest},
    runtime_support::denial_response_for_request,
};

use super::{deny_unowned_approval, reject_unsupported_request};

pub struct CodexApprovalRoute {
    pub operation: Rc<CodexOperation>,
    pub permission_mode: PermissionMode,
    pub active: bool,
}

pub struct CodexApprovalEvents {
    pending: RefCell<CodexPendingApprovalRegistry<usize>>,
    logger: Rc<dyn AgentLogger>,
    clock: Rc<dyn Clock>,
    new_occurrence_id: Rc<dyn Fn() -> String>,
}

impl CodexApprovalEvents {
    pub fn new(
        logger: Rc<dyn AgentLogger>,
        clock: Rc<dyn Clock>,
        new_occurrence_id: Rc<dyn Fn() -> String>,
    ) -> Self {
        Self {
            pending: RefCell::default(),
            logger,
            clock,
            new_occurrence_id,
        }
    }

    pub fn request(
        self: &Rc<Self>,
        client: &CodexAppServerClient,
        request: &JsonRpcServerRequest,
        route: impl FnOnce(&str, &str) -> Option<CodexApprovalRoute>,
    ) -> ExecutorResult<()> {
        if !is_approval_request(request) {
            return reject_unsupported_request(client, request);
        }
        let params = request.params.as_deref().unwrap_or(&Value::Null);
        let thread = params["threadId"]
            .as_str()
            .or_else(|| params["conversationId"].as_str());
        let turn = params["turnId"].as_str();
        let Some(route) = thread
            .filter(|id| !id.is_empty())
            .zip(turn.filter(|id| !id.is_empty()))
            .and_then(|(thread, turn)| route(thread, turn))
        else {
            return deny_unowned_approval(client, self.logger.as_ref(), request);
        };
        let deny = |warning| {
            self.logger.warn(
                warning,
                Some(&IndexMap::from([
                    ("threadId".into(), Opaque::from_value(json!(thread))),
                    ("nativeTurnId".into(), Opaque::from_value(json!(turn))),
                    ("method".into(), Opaque::from_value(json!(request.method))),
                ])),
            );
            client.respond(
                &request.id,
                &denial_response_for_request(&request.method, Some(params)),
            )
        };
        if !route.active {
            return deny("Denied a Codex approval request from an inactive source");
        }
        let pending = create_pending_approval(&route.operation.chat_id, request, || {
            (self.new_occurrence_id)()
        });
        let Ok(message) = build_approval_message(&pending, self.clock.as_ref()) else {
            return deny("Denied an invalid Codex approval request");
        };
        if route.permission_mode == PermissionMode::ManualBypass
            && !matches!(
                message.requested_tool,
                ToolUseChatMessage::AskUserQuestion { .. }
            )
        {
            let decision = PermissionDecisionPayload {
                allow: true,
                always_allow: Some(false),
                response: None,
            };
            return client.respond(
                &request.id,
                &build_approval_response(&pending, &decision, self.clock.as_ref())?,
            );
        }
        let approval = Rc::new(CodexTrackedApproval {
            pending,
            client: client.identity(),
            operation: route.operation,
        });
        if !add_pending_approval(&mut self.pending.borrow_mut(), approval.clone()) {
            return deny("Denied a duplicate Codex approval request ID");
        }
        publish_permission_requested(
            self.logger.as_ref(),
            &approval.pending.chat_id,
            message,
            Rc::new(CodexApprovalDecision {
                approvals: Rc::downgrade(self),
                client: client.clone(),
                approval: approval.clone(),
            }),
            Some(&approval.operation),
        )
    }

    pub fn resolved(&self, client: &CodexAppServerClient, params: &Value) -> ExecutorResult<()> {
        let Some(thread_id) = params["threadId"].as_str() else {
            return Ok(());
        };
        let Some(id) = params["requestId"]
            .as_str()
            .map(|id| JsonRpcId::String(id.into()))
            .or_else(|| as_number(&params["requestId"]).map(|id| JsonRpcId::Number(Number(id))))
        else {
            return Ok(());
        };
        let key = client.identity();
        let approval = {
            let mut pending = self.pending.borrow_mut();
            let candidate = pending
                .get(&key)
                .and_then(|approvals| {
                    approvals.iter().find(|approval| {
                        approval.pending.request_id == id
                            && approval.pending.params["threadId"] == thread_id
                    })
                })
                .cloned();
            candidate.and_then(|candidate| {
                take_pending_approval(&mut pending, &key, &id, Some(&candidate))
            })
        };
        if let Some(approval) = approval {
            publish_permission_expired(
                self.logger.as_ref(),
                &approval.pending.chat_id,
                PermissionExpiredMessage {
                    timestamp: to_iso_string(self.clock.now_ms())?,
                    permission_occurrence_id: approval.pending.permission_occurrence_id.clone(),
                },
                Some(&approval.operation),
            );
        }
        Ok(())
    }

    pub fn cancel(
        &self,
        client: &CodexAppServerClient,
        reason: &str,
        respond: impl FnMut(&CodexTrackedApproval<usize>) -> ExecutorResult<()>,
    ) -> ExecutorResult<()> {
        let key = client.identity();
        let approvals = self.pending.borrow_mut().shift_remove(&key);
        let Some(approvals) = approvals else {
            return Ok(());
        };
        cancel_pending_approvals(
            self.logger.as_ref(),
            &mut IndexMap::from([(key, approvals)]),
            &key,
            reason,
            self.clock.as_ref(),
            respond,
        )
    }
}

struct CodexApprovalDecision {
    approvals: Weak<CodexApprovalEvents>,
    client: CodexAppServerClient,
    approval: Rc<CodexTrackedApproval<usize>>,
}

#[async_trait::async_trait(?Send)]
impl RuntimePermissionResponse for CodexApprovalDecision {
    fn permission_occurrence_id(&self) -> &str {
        &self.approval.pending.permission_occurrence_id
    }

    async fn respond(&self, decision: PermissionDecisionPayload) -> ExecutorResult<()> {
        let no_longer_pending =
            || std::io::Error::other("Codex permission occurrence is no longer pending");
        let approvals = self.approvals.upgrade().ok_or_else(no_longer_pending)?;
        let client = self.client.identity();
        let pending = approvals
            .pending
            .borrow()
            .get(&client)
            .is_some_and(|pending| {
                pending
                    .iter()
                    .any(|entry| Rc::ptr_eq(entry, &self.approval))
            });
        if !pending {
            return Err(no_longer_pending().into());
        }
        let pending = &self.approval.pending;
        let response = build_approval_response(pending, &decision, approvals.clock.as_ref())?;
        self.client.respond(&pending.request_id, &response)?;
        take_pending_approval(
            &mut approvals.pending.borrow_mut(),
            &client,
            &pending.request_id,
            Some(&self.approval),
        );
        Ok(())
    }
}
