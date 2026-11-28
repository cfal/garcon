use std::rc::Rc;

use garcon_cases::{CaseError, replay, text, unknown};
use garcon_chats::chat_processing_activity::{
    ChatProcessingActivity, RunningChatSource, TurnReservationSource,
};
use garcon_contract::chat_types::{ChatProcessingEntry, ChatProcessingPhase};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct Fixture {
    running: Vec<String>,
    reserved: Vec<String>,
    stopping: Vec<String>,
    reconnecting: Vec<String>,
}

impl RunningChatSource for Fixture {
    fn is_chat_running(&self, chat_id: &str) -> bool {
        self.running.iter().any(|id| id == chat_id)
    }

    fn get_running_chat_ids_snapshot(&self) -> Vec<String> {
        self.running.clone()
    }
}

impl TurnReservationSource for Fixture {
    fn is_chat_turn_reserved(&self, chat_id: &str) -> bool {
        self.reserved.iter().any(|id| id == chat_id)
    }

    fn get_turn_reserved_chat_ids(&self) -> Vec<String> {
        self.reserved.clone()
    }

    fn is_chat_stop_in_flight(&self, chat_id: &str) -> bool {
        self.stopping.iter().any(|id| id == chat_id)
    }
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function != "projectProcessing" {
        return Err(CaseError::unhandled(function));
    }
    let fixture = Rc::new(
        serde_json::from_value::<Fixture>(unknown(function, args.first())?.into_owned())
            .map_err(|error| CaseError::undeliverable(error.to_string()))?,
    );
    let chat_id = text(function, args.get(1))?
        .ok_or_else(|| CaseError::undeliverable("expected chat ID string"))?;
    let activity = ChatProcessingActivity {
        running: fixture.clone(),
        reservations: fixture.clone(),
        is_chat_executor_reconnecting: Rc::new(move |id| {
            fixture.reconnecting.iter().any(|current| current == id)
        }),
    };
    #[derive(Serialize)]
    struct Projection {
        phase: Option<ChatProcessingPhase>,
        snapshot: Vec<ChatProcessingEntry>,
    }
    let serialized = serde_json::to_vec(&Projection {
        phase: activity.phase(chat_id),
        snapshot: activity.snapshot(),
    })
    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&serialized)
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[test]
fn recorded_activity_projection_matches_bun() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/chat-processing"),
        dispatch,
    );
}
