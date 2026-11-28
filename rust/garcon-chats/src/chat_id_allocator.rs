//! Allocates monotonic chat IDs without claiming an existing registry ID.

use std::{cell::Cell, rc::Rc};

use garcon_contract::chat_id::{ChatId, InvalidChatIdError, chat_id_from_epoch_microseconds};
use garcon_js::Clock;

const MAX_ALLOCATION_ATTEMPTS: u64 = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum AllocationError {
    #[error(transparent)]
    Invalid(#[from] InvalidChatIdError),
    #[error("Could not allocate a unique chat ID")]
    Exhausted,
}

pub struct ChatIdAllocator {
    clock: Rc<dyn Clock>,
    last: Cell<u64>,
}

impl ChatIdAllocator {
    pub fn new(clock: Rc<dyn Clock>) -> Self {
        Self {
            clock,
            last: Cell::new(0),
        }
    }

    pub fn allocate(&self, has_chat: impl Fn(&str) -> bool) -> Result<ChatId, AllocationError> {
        let observed = i128::from(self.clock.now_ms()) * 1_000;
        let start =
            u64::try_from(observed.max(i128::from(self.last.get()) + 1)).unwrap_or(u64::MAX);
        for candidate in (start..=u64::MAX).take(MAX_ALLOCATION_ATTEMPTS as usize) {
            let id = chat_id_from_epoch_microseconds(candidate)?;
            if !has_chat(&id) {
                self.last.set(candidate);
                return Ok(id);
            }
        }
        Err(AllocationError::Exhausted)
    }
}
