//! Ports `server/controller/chats/carryover/prepared-store.ts`.

use std::cell::RefCell;

use garcon_contract::executors::{ExecutorId, effective_executor_id};
use indexmap::IndexMap;

use super::outcome::CarryOverOutcome;

pub struct PreparedCarryover {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub target_agent_id: String,
    pub target_executor_id: ExecutorId,
    pub target_ownership_epoch: String,
    pub client_request_id: String,
    pub result: CarryOverOutcome,
}

pub struct TakePreparedCarryover<'a> {
    pub chat_id: &'a str,
    pub transcript_view_id: &'a str,
    pub target_agent_id: &'a str,
    pub target_executor_id: Option<&'a str>,
    pub target_ownership_epoch: Option<&'a str>,
    pub client_request_id: Option<&'a str>,
}

#[derive(Default)]
pub struct PreparedCarryoverStore {
    by_chat: RefCell<IndexMap<String, PreparedCarryover>>,
}

impl PreparedCarryoverStore {
    pub fn deposit(&self, value: PreparedCarryover) {
        self.by_chat
            .borrow_mut()
            .insert(value.chat_id.clone(), value);
    }

    pub fn take(&self, input: TakePreparedCarryover<'_>) -> Option<CarryOverOutcome> {
        let value = self.by_chat.borrow_mut().shift_remove(input.chat_id)?;
        if value.transcript_view_id != input.transcript_view_id
            || value.target_agent_id != input.target_agent_id
            || effective_executor_id(Some(&value.target_executor_id))
                != effective_executor_id(input.target_executor_id)
            || Some(value.target_ownership_epoch.as_str()) != input.target_ownership_epoch
            || Some(value.client_request_id.as_str()) != input.client_request_id
        {
            return None;
        }
        Some(value.result)
    }

    pub fn discard(&self, chat_id: &str) {
        self.by_chat.borrow_mut().shift_remove(chat_id);
    }
}
