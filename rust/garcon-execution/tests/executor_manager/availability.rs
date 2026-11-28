use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_base::log::create_logger;
use garcon_cases::{CaseError, replay, text};
use garcon_contract::queue_state::QueueEntryKind;
use garcon_execution::{
    control_state::{
        StoredChatExecutionControlState, StoredQueueEntry, StoredQueueEntryStatus,
        empty_stored_chat_execution_control,
    },
    executor_availability_wiring::{
        ExecutorAvailabilityChats, ExecutorAvailabilityOwnership, ExecutorAvailabilityQueue,
        ExecutorAvailabilitySessions, ExecutorAvailabilityWiring, wire_executor_availability,
    },
    types::ExecutionOperationResult,
};
use garcon_interface::execution_runtime::ExecutorAvailability;
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::task::{LocalSet, yield_now};

use super::{ID, fixture};

struct Effects {
    chats: RefCell<IndexMap<String, String>>,
    effects: RefCell<Vec<Value>>,
    scenario: String,
}

impl Effects {
    fn push(&self, operation: &str, subject: &str) {
        self.effects.borrow_mut().push(json!([operation, subject]));
    }
}

impl ExecutorAvailabilitySessions for Effects {
    fn execution_session_lost(&self, executor_id: &str) {
        self.push("lost", executor_id);
    }
    fn execution_session_resumed(&self, executor_id: &str) {
        self.push("resumed", executor_id);
    }
}

impl ExecutorAvailabilityChats for Effects {
    fn list_chat_ids(&self) -> Vec<String> {
        self.chats.borrow().keys().cloned().collect()
    }
    fn chat_executor_id(&self, chat_id: &str) -> Option<String> {
        self.chats.borrow().get(chat_id).cloned()
    }
}

#[async_trait(?Send)]
impl ExecutorAvailabilityOwnership for Effects {
    async fn retry_provider_cleanup(
        self: Rc<Self>,
        executor_id: &str,
    ) -> ExecutionOperationResult<()> {
        self.push("cleanup", executor_id);
        Ok(())
    }
}

#[async_trait(?Send)]
impl ExecutorAvailabilityQueue for Effects {
    async fn read_chat_execution_control(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.push("read", chat_id);
        yield_now().await;
        match self.scenario.as_str() {
            "retarget" => {
                self.chats
                    .borrow_mut()
                    .insert(chat_id.into(), "local".into());
            }
            "deleted" => {
                self.chats.borrow_mut().shift_remove(chat_id);
            }
            _ => {}
        }
        let mut control = empty_stored_chat_execution_control("synthetic");
        if self.scenario != "empty" {
            control.entries.push(StoredQueueEntry {
                id: "queue-1".into(),
                content: "synthetic".into(),
                kind: QueueEntryKind::Turn,
                images: Vec::new(),
                revision: 1,
                status: StoredQueueEntryStatus::Queued,
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
                submission: None,
            });
        }
        Ok(control)
    }

    fn retry_queued_steers(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        self.push("steer", chat_id);
        Ok(())
    }

    async fn trigger_drain(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        self.push("drain", chat_id);
        Ok(())
    }
}

async fn trace(scenario: &str) -> Value {
    let (_root, manager, remote) = fixture().await;
    let effects = Rc::new(Effects {
        chats: RefCell::new(IndexMap::from([
            ("target".into(), ID.into()),
            ("different".into(), "local".into()),
        ])),
        effects: RefCell::default(),
        scenario: scenario.into(),
    });
    let stop = wire_executor_availability(ExecutorAvailabilityWiring {
        executors: manager.clone(),
        sessions: effects.clone(),
        chats: effects.clone(),
        ownership: effects.clone(),
        queue: effects.clone(),
        publish_processing: Rc::new({
            let effects = effects.clone();
            move |executor| effects.push("processing", executor)
        }),
        logger: Rc::new(create_logger("executor-availability-test")),
    });
    yield_now().await;
    remote.set_availability(ExecutorAvailability::Reconnecting);
    remote.set_availability(ExecutorAvailability::Ready);
    for _ in 0..4 {
        yield_now().await;
    }
    remote.set_availability(ExecutorAvailability::Offline);
    stop();
    remote.set_availability(ExecutorAvailability::Ready);
    yield_now().await;
    manager.dispose().await.unwrap();
    Value::Array(effects.effects.take())
}

#[test]
fn executor_availability_wiring_matches_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/executor-availability"
        ),
        |function, args| {
            if function != "executorAvailabilityTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing scenario"))?;
            Ok(local.block_on(&runtime, trace(scenario)))
        },
    );
}
