//! Ports `server/controller/chats/last-selected-chat-state.ts`.

use std::cell::RefCell;

#[derive(Default)]
pub struct InMemoryLastSelectedChatState {
    last_selected_chat_id: RefCell<Option<String>>,
}

impl InMemoryLastSelectedChatState {
    pub fn get_last_selected_chat_id(&self) -> Option<String> {
        self.last_selected_chat_id.borrow().clone()
    }

    pub fn set_last_selected_chat_id(&self, chat_id: Option<&str>) {
        self.last_selected_chat_id.replace(
            chat_id
                .map(garcon_js::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned),
        );
    }

    pub fn clear_if(&self, chat_id: &str) {
        let mut selected = self.last_selected_chat_id.borrow_mut();
        if selected.as_deref() == Some(chat_id) {
            *selected = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::InMemoryLastSelectedChatState;

    #[test]
    fn stores_normalized_chat_ids_and_clears_on_null_or_empty() {
        let state = InMemoryLastSelectedChatState::default();
        assert_eq!(state.get_last_selected_chat_id(), None);
        state.set_last_selected_chat_id(Some("\u{feff} chat-1 \t"));
        assert_eq!(state.get_last_selected_chat_id().as_deref(), Some("chat-1"));
        state.set_last_selected_chat_id(None);
        assert_eq!(state.get_last_selected_chat_id(), None);
        state.set_last_selected_chat_id(Some("chat-1"));
        state.set_last_selected_chat_id(Some("\t \u{feff}"));
        assert_eq!(state.get_last_selected_chat_id(), None);
    }

    #[test]
    fn clears_only_the_exact_matching_id() {
        let state = InMemoryLastSelectedChatState::default();
        state.set_last_selected_chat_id(Some("chat-1"));
        state.clear_if("chat-2");
        state.clear_if(" chat-1 ");
        assert_eq!(state.get_last_selected_chat_id().as_deref(), Some("chat-1"));
        state.clear_if("chat-1");
        assert_eq!(state.get_last_selected_chat_id(), None);
    }
}
