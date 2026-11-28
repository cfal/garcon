use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatStopIntent {
    Stop,
    InterruptAndSend,
    ChatDeletion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatStopOutcome {
    InterruptRequested,
    AlreadyIdle,
    Failed,
}

pub const CHAT_STOP_OUTCOMES: &[ChatStopOutcome] = &[
    ChatStopOutcome::InterruptRequested,
    ChatStopOutcome::AlreadyIdle,
    ChatStopOutcome::Failed,
];

pub fn is_stop_satisfied(outcome: ChatStopOutcome) -> bool {
    outcome != ChatStopOutcome::Failed
}

pub fn is_abort_acknowledged(outcome: ChatStopOutcome) -> bool {
    outcome == ChatStopOutcome::InterruptRequested
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_satisfaction_from_acknowledgement() {
        assert!(is_stop_satisfied(ChatStopOutcome::InterruptRequested));
        assert!(is_stop_satisfied(ChatStopOutcome::AlreadyIdle));
        assert!(!is_stop_satisfied(ChatStopOutcome::Failed));
        assert!(is_abort_acknowledged(ChatStopOutcome::InterruptRequested));
        assert!(!is_abort_acknowledged(ChatStopOutcome::AlreadyIdle));
        assert!(!is_abort_acknowledged(ChatStopOutcome::Failed));
    }
}
