//! Ports `server-agents/common/src/execution/resource-table.ts`.

use std::cell::RefCell;

use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode},
    resources::{AgentResourceRef, AgentResourceScope, ExecutorResult, create_agent_resource_ref},
};
use indexmap::IndexMap;

pub const DEFAULT_AGENT_RESOURCE_LIMIT: usize = 4096;

pub struct AgentResourceTable<K, T> {
    pub scope: AgentResourceScope,
    pub kind: K,
    limit: usize,
    entries: RefCell<IndexMap<String, T>>,
}

impl<K: Clone + Eq, T> AgentResourceTable<K, T> {
    pub fn new(scope: AgentResourceScope, kind: K, limit: usize) -> Self {
        Self {
            scope,
            kind,
            limit,
            entries: RefCell::default(),
        }
    }

    pub fn add(
        &self,
        value: T,
        new_id: impl FnOnce() -> String,
    ) -> ExecutorResult<AgentResourceRef<K>> {
        let reference = create_agent_resource_ref(self.scope.clone(), self.kind.clone(), new_id);
        self.bind(&reference, value)?;
        Ok(reference)
    }

    pub fn bind(&self, reference: &AgentResourceRef<K>, value: T) -> ExecutorResult<()> {
        self.validate(reference)?;
        let mut entries = self.entries.borrow_mut();
        if entries.contains_key(&reference.id) {
            return Err(stale("Resource is already bound").into());
        }
        if entries.len() >= self.limit {
            return Err(AgentCallError::new(
                AgentDeliveryOutcome::Rejected,
                "Resource budget exhausted",
            )
            .into());
        }
        entries.insert(reference.id.clone(), value);
        Ok(())
    }

    pub fn get(&self, reference: &AgentResourceRef<K>) -> ExecutorResult<T>
    where
        T: Clone,
    {
        self.validate(reference)?;
        self.entries
            .borrow()
            .get(&reference.id)
            .cloned()
            .ok_or_else(|| stale("Resource has retired").into())
    }

    pub fn take(&self, reference: &AgentResourceRef<K>) -> ExecutorResult<T> {
        self.validate(reference)?;
        self.entries
            .borrow_mut()
            .shift_remove(&reference.id)
            .ok_or_else(|| stale("Resource has retired").into())
    }

    pub fn delete(&self, reference: &AgentResourceRef<K>) -> ExecutorResult<()> {
        self.validate(reference)?;
        let removed = self.entries.borrow_mut().shift_remove(&reference.id);
        drop(removed);
        Ok(())
    }

    pub fn remove_where(&self, mut predicate: impl FnMut(&T) -> bool) -> Vec<T> {
        self.entries
            .borrow_mut()
            .extract_if(.., |_, value| predicate(value))
            .map(|(_, value)| value)
            .collect()
    }

    pub fn clear(&self) {
        self.entries.take();
    }

    fn validate(&self, reference: &AgentResourceRef<K>) -> ExecutorResult<()> {
        if reference.kind != self.kind
            || reference.scope != self.scope
            || reference.id.is_empty()
            || reference.scope.executor_id.is_empty()
            || reference.scope.instance_id.is_empty()
            || reference.scope.integration_id.is_empty()
        {
            return Err(stale("Resource belongs to another execution scope").into());
        }
        Ok(())
    }
}

pub(super) fn stale(message: &str) -> AgentCallError {
    AgentCallError::with_code(
        AgentDeliveryOutcome::Rejected,
        message,
        AgentIntegrationErrorCode::STALE_RESOURCE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_scope_then_duplicate_then_budget_and_consumes_handles_once() {
        let scope = AgentResourceScope {
            executor_id: "executor".into(),
            instance_id: "instance".into(),
            integration_id: "test".into(),
        };
        let table = AgentResourceTable::new(scope, "test-kind", 1);
        let first = table.add("one", || "first".into()).unwrap();
        let mut wrong_scope = first.clone();
        wrong_scope.scope.instance_id = "retired-instance".into();
        assert_eq!(
            table.bind(&wrong_scope, "wrong").unwrap_err().to_string(),
            "Resource belongs to another execution scope"
        );
        assert_eq!(
            table.bind(&first, "duplicate").unwrap_err().to_string(),
            "Resource is already bound"
        );
        assert_eq!(
            table
                .add("extra", || "extra".into())
                .unwrap_err()
                .to_string(),
            "Resource budget exhausted"
        );
        assert_eq!(table.take(&first).unwrap(), "one");
        assert_eq!(
            table.take(&first).unwrap_err().to_string(),
            "Resource has retired"
        );
        let second = table.add("two", || "second".into()).unwrap();
        assert_eq!(table.remove_where(|value| value.starts_with('t')), ["two"]);
        assert_eq!(
            table
                .get(&second)
                .unwrap_err()
                .downcast_ref::<AgentCallError>()
                .unwrap()
                .code,
            AgentIntegrationErrorCode::STALE_RESOURCE
        );
        table.delete(&second).unwrap();
    }
}
