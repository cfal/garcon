use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use async_trait::async_trait;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::queue_state::QueueEntryKind;
use indexmap::{IndexMap, IndexSet};

use crate::{
    accepted_input_handler::AcceptedSteerDelivery,
    chat_execution_control_operations::{ChatExecutionControlOperations, ReservedSteer},
    chat_execution_control_transitions::ObservedQueueEntry,
    control_state::{StoredChatExecutionControlState, StoredQueueEntryStatus},
    session_types::AgentSteerOptions,
    steer_input_delivery::SteerInputDelivery,
    types::{
        AcceptedSteerOutcome, CapturedSteerTarget, ExecutionOperationResult, LocalExecutionFuture,
    },
};

#[async_trait(?Send)]
pub trait QueuedSteerControls {
    async fn read(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn reserve_pending_steer(
        &self,
        chat_id: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer>;
    async fn release_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
    async fn consume_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState>;
}

#[async_trait(?Send)]
impl QueuedSteerControls for ChatExecutionControlOperations {
    async fn read(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::read(self, chat_id).await
    }

    async fn reserve_pending_steer(
        &self,
        chat_id: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer> {
        ChatExecutionControlOperations::reserve_pending_steer(self, chat_id, input).await
    }

    async fn release_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::release_steer(self, chat_id, entry_id).await
    }

    async fn consume_steer(
        &self,
        chat_id: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionControlOperations::consume_steer(self, chat_id, entry_id).await
    }
}

#[async_trait(?Send)]
pub trait QueuedSteerInputPort {
    async fn capture_target(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>>;
    async fn deliver(
        &self,
        input: AcceptedSteerDelivery<'_>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome>;
}

#[async_trait(?Send)]
impl QueuedSteerInputPort for SteerInputDelivery {
    async fn capture_target(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>> {
        SteerInputDelivery::capture_target(self, chat_id, deadline).await
    }

    async fn deliver(
        &self,
        input: AcceptedSteerDelivery<'_>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        SteerInputDelivery::deliver(self, input).await
    }
}

pub struct QueuedSteerContent<'a> {
    pub chat_id: &'a str,
    pub client_request_id: &'a str,
    pub content: &'a str,
}

#[async_trait(?Send)]
pub trait QueuedSteerHost {
    async fn resolve_content(
        &self,
        input: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String>;
    fn can_deliver(&self, chat_id: &str) -> bool;
    fn request_drain(&self, chat_id: &str, context: &str) -> ExecutionOperationResult<()>;
    fn track_task(&self, task: LocalExecutionFuture<'static>) -> ExecutionOperationResult<()>;
}

pub struct QueuedSteerDeliveryOptions {
    pub controls: Rc<dyn QueuedSteerControls>,
    pub steer_input: Rc<dyn QueuedSteerInputPort>,
    pub host: Rc<dyn QueuedSteerHost>,
}

pub struct QueuedSteerDelivery {
    options: QueuedSteerDeliveryOptions,
    passes: RefCell<IndexMap<String, Rc<Cell<bool>>>>,
    chats_with_steers: RefCell<IndexSet<String>>,
    // A turn that refused an unrecorded steer would refuse it again after release republishes the queue.
    refusing_turn_ids: RefCell<IndexMap<String, String>>,
    new_id: Box<dyn Fn() -> String>,
    logger: ScopedLogger,
}

struct Pass {
    delivery: Rc<QueuedSteerDelivery>,
    chat_id: String,
    rerun: Rc<Cell<bool>>,
}

impl Drop for Pass {
    fn drop(&mut self) {
        self.delivery
            .passes
            .borrow_mut()
            .shift_remove(&self.chat_id);
    }
}

impl QueuedSteerDelivery {
    pub fn new(options: QueuedSteerDeliveryOptions, new_id: impl Fn() -> String + 'static) -> Self {
        Self {
            options,
            passes: RefCell::default(),
            chats_with_steers: RefCell::default(),
            refusing_turn_ids: RefCell::default(),
            new_id: Box::new(new_id),
            logger: create_logger("queued-steer"),
        }
    }

    pub fn observe(
        self: &Rc<Self>,
        chat_id: &str,
        control: &StoredChatExecutionControlState,
    ) -> ExecutionOperationResult<()> {
        if !control.entries.iter().any(|entry| {
            entry.kind == QueueEntryKind::Steer && entry.status == StoredQueueEntryStatus::Queued
        }) {
            self.forget(chat_id);
            return Ok(());
        }
        self.chats_with_steers.borrow_mut().insert(chat_id.into());
        self.request(chat_id)
    }

    pub fn retry(self: &Rc<Self>, chat_id: &str) -> ExecutionOperationResult<()> {
        let queued = self.chats_with_steers.borrow().contains(chat_id);
        if queued {
            self.request(chat_id)
        } else {
            Ok(())
        }
    }

    pub fn forget(&self, chat_id: &str) {
        self.chats_with_steers.borrow_mut().shift_remove(chat_id);
        self.refusing_turn_ids.borrow_mut().shift_remove(chat_id);
    }

    pub fn request(self: &Rc<Self>, chat_id: &str) -> ExecutionOperationResult<()> {
        let rerun = {
            let mut passes = self.passes.borrow_mut();
            if let Some(rerun) = passes.get(chat_id) {
                rerun.set(true);
                return Ok(());
            }
            let rerun = Rc::new(Cell::new(false));
            passes.insert(chat_id.into(), Rc::clone(&rerun));
            rerun
        };
        let pass = Pass {
            delivery: Rc::clone(self),
            chat_id: chat_id.into(),
            rerun,
        };
        self.options.host.track_task(Box::pin(async move {
            loop {
                pass.delivery.deliver_heads(&pass.chat_id).await;
                if !pass.rerun.replace(false) {
                    return Ok(());
                }
            }
        }))
    }

    async fn deliver_heads(&self, chat_id: &str) {
        loop {
            match self.deliver_head(chat_id).await {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    self.logger
                        .warn(&format!("queued steer delivery failed: {chat_id}: {error}"));
                    return;
                }
            }
        }
    }

    async fn deliver_head(&self, chat_id: &str) -> ExecutionOperationResult<bool> {
        if !self.options.host.can_deliver(chat_id) {
            return Ok(false);
        }
        let control = self.options.controls.read(chat_id).await?;
        let Some(head) = control
            .entries
            .iter()
            .find(|entry| entry.status == StoredQueueEntryStatus::Queued)
        else {
            return Ok(false);
        };
        if control.pause.is_some()
            || head.kind != QueueEntryKind::Steer
            || control
                .entries
                .iter()
                .any(|entry| entry.status == StoredQueueEntryStatus::Steering)
        {
            return Ok(false);
        }
        // Direct queue entries without a submission are left for the drain.
        let Some(submission) = &head.submission else {
            return Ok(false);
        };
        let Some(target) = self.steerable_target(chat_id).await else {
            return Ok(false);
        };

        let client_request_id = (self.new_id)();
        let provider_content = self
            .options
            .host
            .resolve_content(QueuedSteerContent {
                chat_id,
                client_request_id: &client_request_id,
                content: &head.content,
            })
            .await?;
        let Ok(ReservedSteer { entry, .. }) = self
            .options
            .controls
            .reserve_pending_steer(
                chat_id,
                &ObservedQueueEntry {
                    entry_id: head.id.clone(),
                    expected_revision: head.revision,
                    expected_reorder_revision: control.reorder_revision,
                },
            )
            .await
        else {
            // A pause or edit while resolving context is visible on the next read.
            return Ok(true);
        };
        let admitted = Cell::new(false);
        let result = self
            .options
            .steer_input
            .deliver(AcceptedSteerDelivery {
                chat_id,
                content: &entry.content,
                provider_content: &provider_content,
                options: AgentSteerOptions {
                    client_request_id,
                    client_message_id: submission.client_message_id.clone(),
                    transcript_view_id: submission.transcript_view_id.clone(),
                    question_reply: None,
                },
                target: &target,
                after_pending_registered: Box::new(|_| {
                    Box::pin(async {
                        admitted.set(true);
                        Ok(())
                    })
                }),
                user_message_presentation: None,
            })
            .await;
        if let Err(error) = result {
            if !admitted.get() {
                self.refusing_turn_ids
                    .borrow_mut()
                    .insert(chat_id.into(), target.turn_id);
                self.options
                    .controls
                    .release_steer(chat_id, &entry.id)
                    .await?;
                self.options
                    .host
                    .request_drain(chat_id, "queued steer released")?;
                return Ok(false);
            }
            self.logger.warn(&format!(
                "queued steer was recorded but not confirmed: {chat_id}/{}: {error}",
                entry.id
            ));
        }
        self.options
            .controls
            .consume_steer(chat_id, &entry.id)
            .await?;
        self.options
            .host
            .request_drain(chat_id, "queued steer consumed")?;
        Ok(true)
    }

    async fn steerable_target(&self, chat_id: &str) -> Option<CapturedSteerTarget> {
        let target = self
            .options
            .steer_input
            .capture_target(chat_id, None)
            .await
            .ok()
            .flatten()?;
        if target.provider_target.is_none()
            || self.refusing_turn_ids.borrow().get(chat_id) == Some(&target.turn_id)
        {
            None
        } else {
            Some(target)
        }
    }
}
