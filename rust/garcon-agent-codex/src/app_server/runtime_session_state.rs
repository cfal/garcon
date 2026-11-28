use std::{cell::RefCell, collections::HashSet, rc::Rc};

use garcon_agents_common::execution::runtime_events::AgentRuntimeEvent;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::operation_routes::CodexOperation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunningStatus {
    Running,
    Interrupting,
    Completing,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishSessionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_message: Option<String>,
    #[serde(default)]
    pub aborted: bool,
    #[serde(default)]
    pub emit_finished_on_abort: bool,
}

pub struct CodexTurnRoutes {
    source_operation: Rc<CodexOperation>,
    next_operation: Option<Rc<CodexOperation>>,
    active_turn_id: Option<String>,
    operations: IndexMap<String, Rc<CodexOperation>>,
    terminal_turn_ids: HashSet<String>,
}

impl CodexTurnRoutes {
    pub fn new(operation: Rc<CodexOperation>) -> Self {
        Self {
            source_operation: operation.clone(),
            next_operation: Some(operation),
            active_turn_id: None,
            operations: IndexMap::new(),
            terminal_turn_ids: HashSet::new(),
        }
    }

    pub fn reactivate(&mut self, operation: Rc<CodexOperation>) {
        self.active_turn_id = None;
        self.source_operation = operation.clone();
        self.next_operation = Some(operation);
    }

    pub fn expect_turn(&mut self, operation: Rc<CodexOperation>) {
        self.next_operation = Some(operation);
    }

    pub fn operation_for_start(&self) -> Rc<CodexOperation> {
        self.next_operation
            .as_ref()
            .unwrap_or(&self.source_operation)
            .clone()
    }

    pub(super) fn source_operation(&self) -> Rc<CodexOperation> {
        self.source_operation.clone()
    }

    pub fn operation_for_turn(&self, turn_id: &str) -> Option<&Rc<CodexOperation>> {
        self.operations.get(turn_id)
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }

    pub fn adopt_turn(
        routes: &RefCell<Self>,
        turn_id: &str,
        operation: Rc<CodexOperation>,
    ) -> bool {
        if !routes.borrow_mut().route_turn(turn_id, operation.clone()) {
            return false;
        }
        // Publication can read the route to capture the newly steerable turn.
        (operation.publish)(AgentRuntimeEvent::Steerable);
        true
    }

    fn route_turn(&mut self, turn_id: &str, operation: Rc<CodexOperation>) -> bool {
        if self.operations.contains_key(turn_id) {
            return false;
        }
        self.operations.insert(turn_id.into(), operation.clone());
        self.active_turn_id = Some(turn_id.into());
        if self
            .next_operation
            .as_ref()
            .is_some_and(|next| Rc::ptr_eq(next, &operation))
        {
            self.next_operation = None;
        }
        true
    }

    pub fn mark_terminal(&mut self, turn_id: &str) -> bool {
        self.terminal_turn_ids.insert(turn_id.into())
    }

    pub fn finish_active_turn(&mut self) {
        self.active_turn_id = None;
    }

    pub fn retire(&mut self) {
        self.operations.clear();
        self.terminal_turn_ids.clear();
        self.next_operation = None;
        self.active_turn_id = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::operation_routes::codex_operation;

    fn operation(id: &str) -> Rc<CodexOperation> {
        codex_operation("chat", id, Rc::new(|_| {}))
    }

    #[test]
    fn retained_writer_keeps_each_native_turn_bound_to_its_original_run() {
        let first = operation("first");
        let second = operation("second");
        let routes = RefCell::new(CodexTurnRoutes::new(first.clone()));
        assert!(CodexTurnRoutes::adopt_turn(
            &routes,
            "turn-1",
            first.clone()
        ));
        assert!(routes.borrow_mut().mark_terminal("turn-1"));
        assert!(!routes.borrow_mut().mark_terminal("turn-1"));
        routes.borrow_mut().finish_active_turn();
        routes.borrow_mut().reactivate(second.clone());
        assert!(!CodexTurnRoutes::adopt_turn(
            &routes,
            "turn-1",
            second.clone()
        ));
        assert_eq!(routes.borrow().active_turn_id(), None);
        assert!(CodexTurnRoutes::adopt_turn(
            &routes,
            "turn-2",
            second.clone()
        ));
        let mut routes = routes.into_inner();
        assert_eq!(routes.active_turn_id(), Some("turn-2"));
        assert!(Rc::ptr_eq(
            routes.operation_for_turn("turn-1").unwrap(),
            &first
        ));
        assert!(Rc::ptr_eq(
            routes.operation_for_turn("turn-2").unwrap(),
            &second
        ));
        routes.retire();
        assert!(routes.operation_for_turn("turn-1").is_none());
        assert!(routes.operation_for_turn("turn-2").is_none());
    }

    #[test]
    fn publishes_steerable_once_per_turn_regardless_of_which_start_path_wins() {
        let routes = Rc::new(RefCell::new(CodexTurnRoutes::new(operation("unused"))));
        let steerable_turns = Rc::new(RefCell::new(Vec::new()));
        let publisher = {
            let routes = Rc::downgrade(&routes);
            let steerable_turns = steerable_turns.clone();
            Rc::new(move |event| {
                assert!(matches!(event, AgentRuntimeEvent::Steerable));
                let routes = routes.upgrade().unwrap();
                let routes = routes
                    .try_borrow_mut()
                    .expect("routes released before publication");
                let turn_id = routes.active_turn_id().unwrap();
                assert_eq!(routes.operation_for_turn(turn_id).unwrap().run_id, "run");
                steerable_turns.borrow_mut().push(turn_id.to_owned());
            })
        };
        let operation = codex_operation("chat", "run", publisher);
        routes.borrow_mut().reactivate(operation.clone());
        assert!(steerable_turns.borrow().is_empty());

        // The managed RPC response, a turn/started notification, and a retry RPC
        // response can each be the first report of a new native turn.
        for (turn_id, expected) in [("managed", 1), ("notification", 2), ("retry", 3)] {
            routes.borrow_mut().finish_active_turn();
            routes.borrow_mut().expect_turn(operation.clone());
            let owner = routes.borrow().operation_for_start();
            assert!(CodexTurnRoutes::adopt_turn(&routes, turn_id, owner));
            assert_eq!(steerable_turns.borrow().len(), expected);
            assert!(!CodexTurnRoutes::adopt_turn(
                &routes,
                turn_id,
                operation.clone()
            ));
            assert_eq!(steerable_turns.borrow().len(), expected);
        }
        assert_eq!(
            *steerable_turns.borrow(),
            ["managed", "notification", "retry"]
        );
    }
}
