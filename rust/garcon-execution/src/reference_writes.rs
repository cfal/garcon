//! Retains both sides of a reference write until persistence and publication finish.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use garcon_base::domain_error::DomainError;
use garcon_contract::{
    error_codes::ErrorCode,
    executors::{LOCAL_EXECUTOR_ID, effective_executor_id},
};
use indexmap::IndexSet;

use crate::types::ExecutionOperationResult;

pub type ReleaseExecutorReferences = Box<dyn FnOnce()>;
pub type RetainExecutorReferences = Rc<
    dyn Fn(&[Option<&str>], &[Option<&str>]) -> ExecutionOperationResult<ReleaseExecutorReferences>,
>;
type AssertWritable = dyn Fn(&str) -> ExecutionOperationResult<()>;

pub struct ExecutorReferenceWrites {
    writers: Rc<RefCell<HashMap<String, usize>>>,
    assert_writable: Rc<AssertWritable>,
}

impl ExecutorReferenceWrites {
    pub fn new(assert_writable: impl Fn(&str) -> ExecutionOperationResult<()> + 'static) -> Self {
        Self {
            writers: Rc::default(),
            assert_writable: Rc::new(assert_writable),
        }
    }

    /// Checks new references before retaining any of them. Existing references
    /// must remain retained even when their executor is no longer writable.
    pub fn retain(
        &self,
        next: &[Option<&str>],
        current: &[Option<&str>],
    ) -> ExecutionOperationResult<ReleaseExecutorReferences> {
        let previous = remote_ids(current);
        let mut executors = remote_ids(next);
        for id in &executors {
            if !previous.contains(id) {
                (self.assert_writable)(id)?;
            }
        }
        executors.extend(previous);
        {
            let mut writers = self.writers.borrow_mut();
            for id in &executors {
                *writers.entry(id.clone()).or_default() += 1;
            }
        }
        let retention = ReferenceRetention {
            writers: self.writers.clone(),
            executors,
        };
        Ok(Box::new(move || drop(retention)))
    }

    /// Moves the release handle into the write task, not its cancellable waiter.
    pub fn retention_callback(self: &Rc<Self>) -> RetainExecutorReferences {
        let writes = self.clone();
        Rc::new(move |next, current| writes.retain(next, current))
    }

    pub fn assert_no_writes(&self, executor_id: &str) -> Result<(), DomainError> {
        if self.writers.borrow().contains_key(executor_id) {
            Err(DomainError::new(
                ErrorCode::EXECUTOR_IN_USE,
                "A reference to this executor is being saved. Try deleting it after the save finishes.",
                409,
                true,
            ))
        } else {
            Ok(())
        }
    }
}

struct ReferenceRetention {
    writers: Rc<RefCell<HashMap<String, usize>>>,
    executors: IndexSet<String>,
}

impl Drop for ReferenceRetention {
    fn drop(&mut self) {
        let mut writers = self.writers.borrow_mut();
        for id in &self.executors {
            // INFALLIBLE: this handle owns one count for each executor and drops only once.
            let count = writers.get_mut(id).expect("retained executor reference");
            *count -= 1;
            if *count == 0 {
                writers.remove(id);
            }
        }
    }
}

fn remote_ids(values: &[Option<&str>]) -> IndexSet<String> {
    values
        .iter()
        .map(|id| effective_executor_id(*id))
        .filter(|id| id != LOCAL_EXECUTOR_ID)
        .collect()
}
