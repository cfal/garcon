use garcon_js::utf16;
use serde::Serialize;

use crate::chat_types::ChatMessage;

use super::{
    MissingNativeSeedSessionId, NativeSeedFormat, NativeSeedPlacement, NativeSeedReceipt,
    retarget_native_seed_receipt, sha256,
    units::{prefix, suffix},
};

const CARRIED_CONTEXT_OPEN_PREFIX: &str = "<carried-context";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SanitizeCarriedContextResult {
    NotApplicable {
        messages: Vec<ChatMessage>,
    },
    StrippedExact {
        messages: Vec<ChatMessage>,
    },
    Absent {
        messages: Vec<ChatMessage>,
    },
    Mismatch {
        messages: Vec<ChatMessage>,
        reason: &'static str,
    },
}

pub fn retarget_native_seed_receipt_if_preserved(
    receipt: Option<&NativeSeedReceipt>,
    agent_session_id: &str,
    messages: &[ChatMessage],
) -> Result<Option<NativeSeedReceipt>, MissingNativeSeedSessionId> {
    let Some(receipt) = receipt else {
        return Ok(None);
    };
    let Some(user) = messages.iter().find_map(|message| match message {
        ChatMessage::User(user) => Some(user),
        _ => None,
    }) else {
        return Ok(None);
    };
    if matching_prefix_units(receipt, &user.content).is_none()
        || (receipt.placement == NativeSeedPlacement::ProviderContext
            && utf16::len(&user.content) as u64 != receipt.code_unit_length)
    {
        return Ok(None);
    }
    retarget_native_seed_receipt(Some(receipt), agent_session_id)
}

pub fn sanitize_recorded_carried_context(
    mut messages: Vec<ChatMessage>,
    receipt: Option<&NativeSeedReceipt>,
    agent_session_id: Option<&str>,
) -> SanitizeCarriedContextResult {
    use SanitizeCarriedContextResult::*;

    let Some(receipt) = receipt else {
        return NotApplicable { messages };
    };
    if agent_session_id.filter(|id| !id.is_empty()) != Some(receipt.agent_session_id.as_str()) {
        return Mismatch {
            messages,
            reason: "Seed receipt does not name the current native session",
        };
    }
    if receipt.placement == NativeSeedPlacement::ProviderContext {
        return NotApplicable { messages };
    }

    let Some(user) = messages.iter_mut().find_map(|message| match message {
        ChatMessage::User(user) => Some(user),
        _ => None,
    }) else {
        return Absent { messages };
    };
    if let Some(units) = matching_prefix_units(receipt, &user.content) {
        user.content = suffix(&user.content, units).into_owned();
        return StrippedExact { messages };
    }
    if receipt.format != NativeSeedFormat::LegacyV0
        && user.content.starts_with(CARRIED_CONTEXT_OPEN_PREFIX)
    {
        return Mismatch {
            messages,
            reason: "Recorded carried-context XML was rewritten",
        };
    }
    Absent { messages }
}

fn matching_prefix_units(receipt: &NativeSeedReceipt, content: &str) -> Option<isize> {
    let units = isize::try_from(receipt.code_unit_length).ok()?;
    if utf16::len(content) < units as usize {
        return None;
    }
    let digest = sha256(&prefix(content, units as usize));
    (digest == receipt.sha256).then_some(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_types::UserMessage;
    use crate::transcript_seed::{NativeSeedReceiptInput, create_native_seed_receipt};

    fn user(content: String) -> ChatMessage {
        ChatMessage::User(UserMessage {
            timestamp: "2026-11-28T00:00:00Z".to_owned(),
            content,
            images: None,
            metadata: None,
            presentation: None,
        })
    }

    #[test]
    fn strips_only_the_exact_receipt_bound_prefix_for_the_current_session() {
        let prefix = "<carried-context>Synthetic \u{1f642}</carried-context>\n";
        let receipt = create_native_seed_receipt(NativeSeedReceiptInput {
            agent_session_id: "source",
            placement: NativeSeedPlacement::UserPrefix,
            prefix,
            format: None,
        })
        .unwrap();
        let messages = vec![user(format!("{prefix}Ask")), user(prefix.to_owned())];
        assert!(matches!(
            sanitize_recorded_carried_context(messages.clone(), Some(&receipt), Some("other")),
            SanitizeCarriedContextResult::Mismatch { .. }
        ));
        assert_eq!(
            sanitize_recorded_carried_context(messages, Some(&receipt), Some("source")),
            SanitizeCarriedContextResult::StrippedExact {
                messages: vec![user("Ask".to_owned()), user(prefix.to_owned())],
            },
        );
    }
}
