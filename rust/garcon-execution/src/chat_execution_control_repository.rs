//! Ports the process-local controller repository; it has no persistence API.

use std::{cell::RefCell, collections::HashMap};

use crate::control_state::{
    StoredChatExecutionControlState, clone_stored_chat_execution_control,
    empty_stored_chat_execution_control,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Cannot save execution controls from another server instance")]
pub struct ForeignExecutionControl;

pub trait ChatExecutionControlRepository {
    fn load(&self, chat_id: &str) -> StoredChatExecutionControlState;
    fn save(
        &self,
        chat_id: &str,
        control: &StoredChatExecutionControlState,
    ) -> Result<StoredChatExecutionControlState, ForeignExecutionControl>;
    fn delete(&self, chat_id: &str);
}

pub struct InMemoryChatExecutionControlRepository {
    server_instance_id: String,
    controls_by_chat_id: RefCell<HashMap<String, StoredChatExecutionControlState>>,
}

impl InMemoryChatExecutionControlRepository {
    pub fn new(server_instance_id: String) -> Self {
        Self {
            server_instance_id,
            controls_by_chat_id: RefCell::new(HashMap::new()),
        }
    }

    pub fn server_instance_id(&self) -> &str {
        &self.server_instance_id
    }
}

impl ChatExecutionControlRepository for InMemoryChatExecutionControlRepository {
    fn load(&self, chat_id: &str) -> StoredChatExecutionControlState {
        self.controls_by_chat_id.borrow().get(chat_id).map_or_else(
            || empty_stored_chat_execution_control(&self.server_instance_id),
            clone_stored_chat_execution_control,
        )
    }

    fn save(
        &self,
        chat_id: &str,
        control: &StoredChatExecutionControlState,
    ) -> Result<StoredChatExecutionControlState, ForeignExecutionControl> {
        if control.server_instance_id != self.server_instance_id {
            return Err(ForeignExecutionControl);
        }
        let saved = clone_stored_chat_execution_control(control);
        self.controls_by_chat_id
            .borrow_mut()
            .insert(chat_id.to_owned(), saved.clone());
        Ok(saved)
    }

    fn delete(&self, chat_id: &str) {
        self.controls_by_chat_id.borrow_mut().remove(chat_id);
    }
}
