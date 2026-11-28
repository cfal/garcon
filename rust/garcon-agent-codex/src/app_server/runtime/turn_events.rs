use std::{cell::RefCell, rc::Rc};

use garcon_interface::{host::AgentLogger, producer::AgentFinalResponse};

use crate::app_server::{
    client::CodexAppServerClient,
    converter::{convert_codex_app_server_live_item, convert_codex_raw_code_mode_item},
    operation_routes::{CodexOperation, publish_rows},
    protocol::{CodexThreadItem, JsonRpcNotification, read_live_thread_item},
    runtime_session_state::{CodexTurnRoutes, RunningStatus},
};

use super::{
    source_registry::{CodexSessionSource, CodexSourceRegistry},
    terminal::{CodexCompletedTurn, final_response},
};

pub struct CodexObservedTurnCompletion {
    pub source: Rc<CodexSessionSource>,
    pub operation: Rc<CodexOperation>,
    pub turn: CodexCompletedTurn,
    pub is_active: bool,
    pub final_response: Option<AgentFinalResponse>,
}

// Projects rows before handing completion back to the session lifecycle.
pub fn dispatch_turn_notification(
    registry: &RefCell<CodexSourceRegistry>,
    logger: &dyn AgentLogger,
    client: &CodexAppServerClient,
    timestamp: &str,
    notification: &JsonRpcNotification,
) -> Option<CodexObservedTurnCompletion> {
    let params = notification.params.as_deref()?;
    let thread_id = params["threadId"].as_str()?;
    match notification.method.as_str() {
        "turn/started" => {
            let turn_id = params["turn"]["id"].as_str()?;
            let source = registry
                .borrow()
                .session_for_client_thread(client, thread_id);
            if let Some(source) = source {
                let operation = source.routes.borrow().operation_for_start();
                if CodexTurnRoutes::adopt_turn(&source.routes, turn_id, operation)
                    && source.status.get() != RunningStatus::Interrupting
                {
                    source.status.set(RunningStatus::Running);
                }
            }
        }
        "item/completed" | "rawResponseItem/completed" => {
            let turn_id = params["turnId"].as_str()?;
            let (source, operation) = registry
                .borrow()
                .source_for_client_turn(client, thread_id, turn_id)?;
            if notification.method == "item/completed" {
                if let Some(item) = read_live_thread_item(&params["item"]) {
                    emit_item(&source, logger, &operation, turn_id, &item, timestamp);
                }
            } else {
                let item = &params["item"];
                let messages = convert_codex_raw_code_mode_item(
                    item,
                    timestamp,
                    &mut source.live_raw_results.borrow_mut(),
                );
                let rows = source.items.borrow_mut().emit_converted(
                    turn_id,
                    item["id"].as_str(),
                    messages,
                );
                publish_rows(logger, &source.chat_id, rows, Some(&operation));
            }
        }
        "turn/completed" => {
            let turn_id = params["turn"]["id"].as_str()?;
            let (source, operation) = registry
                .borrow()
                .source_for_client_turn(client, thread_id, turn_id)?;
            let turn = CodexCompletedTurn::read(turn_id, &params["turn"]);
            let is_current_source = registry
                .borrow()
                .active(thread_id)
                .is_some_and(|active| Rc::ptr_eq(&active, &source));
            let (first_completion, is_active) = {
                let mut routes = source.routes.borrow_mut();
                let is_active = is_current_source && routes.active_turn_id() == Some(turn_id);
                let first = routes.mark_terminal(turn_id);
                if first && is_active {
                    routes.mark_active_completion(operation.clone());
                }
                (first, is_active)
            };
            if first_completion && is_active {
                source.live_raw_results.borrow_mut().clear();
            }
            for item in &turn.items {
                emit_item(&source, logger, &operation, turn_id, item, timestamp);
            }
            if first_completion {
                return Some(CodexObservedTurnCompletion {
                    source,
                    operation,
                    final_response: final_response(&turn),
                    turn,
                    is_active,
                });
            }
        }
        _ => {}
    }
    None
}

fn emit_item(
    source: &CodexSessionSource,
    logger: &dyn AgentLogger,
    operation: &CodexOperation,
    turn_id: &str,
    item: &CodexThreadItem,
    timestamp: &str,
) {
    let rows = source
        .items
        .borrow_mut()
        .emit(turn_id, item, |item, trigger| {
            convert_codex_app_server_live_item(item.payload(), timestamp, trigger)
        });
    publish_rows(logger, &source.chat_id, rows, Some(operation));
}
