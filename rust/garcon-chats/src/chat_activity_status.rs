//! User-facing status derived from already-projected processing and activity.

use garcon_contract::{
    chat_activity::{ChatActivityStatus, ChatRunOutcome},
    chat_types::ChatProcessingPhase,
};

pub fn project_chat_activity_status(
    processing_phase: Option<ChatProcessingPhase>,
    pending_user_action: bool,
    last_run_outcome: Option<ChatRunOutcome>,
) -> Option<ChatActivityStatus> {
    if processing_phase.is_some() {
        return Some(if pending_user_action {
            ChatActivityStatus::PendingUserAction
        } else {
            ChatActivityStatus::Working
        });
    }
    match last_run_outcome {
        Some(ChatRunOutcome::Finished) => Some(ChatActivityStatus::Complete),
        Some(ChatRunOutcome::Failed) => Some(ChatActivityStatus::Error),
        _ => None,
    }
}
