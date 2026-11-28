//! Ports `server/controller/chats/chat-processing-activity.ts`.

use std::{collections::HashSet, rc::Rc};

use garcon_contract::chat_types::{ChatProcessingEntry, ChatProcessingPhase};
use garcon_js::utf16;

pub trait RunningChatSource {
    fn is_chat_running(&self, chat_id: &str) -> bool;
    fn get_running_chat_ids_snapshot(&self) -> Vec<String>;
}

pub trait TurnReservationSource {
    fn is_chat_turn_reserved(&self, chat_id: &str) -> bool;
    fn get_turn_reserved_chat_ids(&self) -> Vec<String>;
    fn is_chat_stop_in_flight(&self, chat_id: &str) -> bool;
}

pub struct ChatProcessingActivity {
    pub running: Rc<dyn RunningChatSource>,
    pub reservations: Rc<dyn TurnReservationSource>,
    pub is_chat_executor_reconnecting: Rc<dyn Fn(&str) -> bool>,
}

impl ChatProcessingActivity {
    /// Transcript ownership can outlive visible processing; only active turns
    /// and their reservations are included here.
    pub fn phase(&self, chat_id: &str) -> Option<ChatProcessingPhase> {
        use ChatProcessingPhase::{Reconnecting, Running, Stopping};

        if !self.running.is_chat_running(chat_id)
            && !self.reservations.is_chat_turn_reserved(chat_id)
        {
            return None;
        }
        Some(if self.reservations.is_chat_stop_in_flight(chat_id) {
            Stopping
        } else if (self.is_chat_executor_reconnecting)(chat_id) {
            Reconnecting
        } else {
            Running
        })
    }

    pub fn snapshot(&self) -> Vec<ChatProcessingEntry> {
        let chat_ids: HashSet<_> = self
            .running
            .get_running_chat_ids_snapshot()
            .into_iter()
            .chain(self.reservations.get_turn_reserved_chat_ids())
            .collect();
        let mut chat_ids: Vec<_> = chat_ids.into_iter().collect();
        chat_ids.sort_by(|left, right| utf16::cmp(left, right));
        chat_ids
            .into_iter()
            .filter_map(|chat_id| {
                let phase = self.phase(&chat_id)?;
                Some(ChatProcessingEntry { chat_id, phase })
            })
            .collect()
    }
}
