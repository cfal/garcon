use std::{hash::Hash, rc::Rc};

use garcon_contract::chat_types::PermissionCancelledMessage;
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{
    clock::{Clock, to_iso_string},
    json::Opaque,
};
use indexmap::IndexMap;
use serde_json::json;

use super::CodexPendingApproval;
use crate::app_server::{
    operation_routes::{CodexOperation, publish_permission_cancelled},
    protocol::JsonRpcId,
};

pub struct CodexTrackedApproval<Client> {
    pub pending: CodexPendingApproval,
    pub client: Client,
    pub operation: Rc<CodexOperation>,
}

pub type CodexPendingApprovalRegistry<Client> =
    IndexMap<Client, Vec<Rc<CodexTrackedApproval<Client>>>>;

pub fn add_pending_approval<Client: Clone + Eq + Hash>(
    registry: &mut CodexPendingApprovalRegistry<Client>,
    approval: Rc<CodexTrackedApproval<Client>>,
) -> bool {
    let approvals = registry.entry(approval.client.clone()).or_default();
    if approvals
        .iter()
        .any(|existing| existing.pending.request_id == approval.pending.request_id)
    {
        return false;
    }
    approvals.push(approval);
    true
}

pub fn take_pending_approval<Client: Eq + Hash>(
    registry: &mut CodexPendingApprovalRegistry<Client>,
    client: &Client,
    request_id: &JsonRpcId,
    expected: Option<&Rc<CodexTrackedApproval<Client>>>,
) -> Option<Rc<CodexTrackedApproval<Client>>> {
    let approvals = registry.get_mut(client)?;
    let position = approvals.iter().position(|approval| {
        approval.pending.request_id == *request_id
            && expected.is_none_or(|expected| Rc::ptr_eq(approval, expected))
    })?;
    let approval = approvals.remove(position);
    if approvals.is_empty() {
        registry.shift_remove(client);
    }
    Some(approval)
}

pub fn cancel_pending_approvals<Client: Eq + Hash>(
    logger: &dyn AgentLogger,
    registry: &mut CodexPendingApprovalRegistry<Client>,
    client: &Client,
    reason: &str,
    clock: &dyn Clock,
    mut respond: impl FnMut(&CodexTrackedApproval<Client>) -> ExecutorResult<()>,
) -> ExecutorResult<()> {
    let Some(approvals) = registry.shift_remove(client) else {
        return Ok(());
    };
    for approval in approvals {
        respond(&approval)?;
        publish_permission_cancelled(
            logger,
            &approval.pending.chat_id,
            PermissionCancelledMessage {
                timestamp: to_iso_string(clock.now_ms())?,
                permission_occurrence_id: approval.pending.permission_occurrence_id.clone(),
                reason: Some(Opaque::from_value(json!(reason))),
            },
            Some(&approval.operation),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use garcon_agents_common::execution::runtime_events::AgentRuntimeEvent;
    use garcon_interface::producer::{AgentProviderPermissionLifecycle, AgentTerminalPermission};
    use garcon_js::{Number, clock::ManualClock};

    use crate::app_server::{operation_routes::codex_operation, runtime_support::NoopLogger};

    use super::*;

    fn approval(
        client: u8,
        request_id: JsonRpcId,
        occurrence: &str,
        operation: Rc<CodexOperation>,
    ) -> Rc<CodexTrackedApproval<u8>> {
        Rc::new(CodexTrackedApproval {
            client,
            pending: CodexPendingApproval {
                permission_occurrence_id: occurrence.into(),
                request_id,
                chat_id: "chat".into(),
                method: "item/commandExecution/requestApproval".into(),
                params: Opaque::from_value(json!({})),
            },
            operation,
        })
    }

    #[test]
    fn expires_only_the_matching_client_request_after_external_resolution() {
        let operation = codex_operation("chat", "run", Rc::new(|_| {}));
        let numeric = JsonRpcId::Number(Number(17.0));
        let string = JsonRpcId::String("17".into());
        let original = approval(1, numeric.clone(), "first", operation.clone());
        let replacement = approval(1, numeric.clone(), "duplicate", operation.clone());
        let second_client = approval(2, numeric.clone(), "second-client", operation.clone());
        let string_request = approval(1, string.clone(), "string", operation);
        let mut registry = CodexPendingApprovalRegistry::new();
        assert!(add_pending_approval(&mut registry, original.clone()));
        assert!(add_pending_approval(&mut registry, second_client.clone()));
        assert!(!add_pending_approval(&mut registry, replacement.clone()));
        assert!(add_pending_approval(&mut registry, string_request.clone()));
        assert!(take_pending_approval(&mut registry, &1, &numeric, Some(&replacement)).is_none());
        let taken = take_pending_approval(&mut registry, &1, &numeric, Some(&original)).unwrap();
        assert!(Rc::ptr_eq(&original, &taken));
        assert!(take_pending_approval(&mut registry, &1, &numeric, None).is_none());
        let taken = take_pending_approval(&mut registry, &1, &string, None).unwrap();
        assert!(Rc::ptr_eq(&string_request, &taken));
        let taken = take_pending_approval(&mut registry, &2, &numeric, None).unwrap();
        assert!(Rc::ptr_eq(&second_client, &taken));
        assert!(registry.is_empty());
    }

    #[test]
    fn cancels_approvals_through_their_captured_turn_operations() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let publisher = Rc::new({
            let events = events.clone();
            move |event| {
                let AgentRuntimeEvent::Permission {
                    run_id,
                    lifecycle:
                        AgentProviderPermissionLifecycle::Terminal(AgentTerminalPermission::Cancelled {
                            permission_occurrence_id,
                            reason,
                        }),
                    decision: None,
                } = event
                else {
                    panic!("expected cancellation");
                };
                events
                    .borrow_mut()
                    .push((run_id, permission_occurrence_id, reason));
            }
        });
        let old = codex_operation("chat", "old-run", publisher.clone());
        let new = codex_operation("chat", "new-run", publisher);
        let mut registry = CodexPendingApprovalRegistry::new();
        assert!(add_pending_approval(
            &mut registry,
            approval(1, JsonRpcId::Number(Number(1.0)), "first", old)
        ));
        assert!(add_pending_approval(
            &mut registry,
            approval(1, JsonRpcId::Number(Number(2.0)), "second", new.clone())
        ));
        assert!(add_pending_approval(
            &mut registry,
            approval(2, JsonRpcId::Number(Number(1.0)), "other", new)
        ));
        let mut responses = Vec::new();
        cancel_pending_approvals(
            &NoopLogger,
            &mut registry,
            &1,
            "aborted",
            &ManualClock::new(0),
            |approval| {
                responses.push(approval.pending.permission_occurrence_id.clone());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(responses, ["first", "second"]);
        let expected = [
            (
                "old-run".to_owned(),
                "first".to_owned(),
                Some("aborted".to_owned()),
            ),
            (
                "new-run".to_owned(),
                "second".to_owned(),
                Some("aborted".to_owned()),
            ),
        ];
        assert_eq!(events.borrow().as_slice(), expected);
        assert!(registry.get(&1).is_none());
        assert!(registry.contains_key(&2));
    }
}
