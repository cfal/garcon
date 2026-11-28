use garcon_cases::{CaseError, unknown};
use garcon_contract::chat_tag_mutations::{
    normalize_chat_tag_conflict_response, normalize_chat_tags_mutation_response,
    normalize_command_tag_mutation_outcome, normalize_recover_chat_tags_response,
};

use crate::helpers::{plain, recorded_cases};

#[test]
fn chat_tag_mutation_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-tag-mutations"
        ),
        "common/chat-tag-mutations.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            match function {
                "normalizeChatTagConflictResponse" => {
                    Ok(plain(normalize_chat_tag_conflict_response(&value)))
                }
                "normalizeChatTagsMutationResponse" => {
                    Ok(plain(normalize_chat_tags_mutation_response(&value)))
                }
                "normalizeCommandTagMutationOutcome" => {
                    Ok(plain(normalize_command_tag_mutation_outcome(&value)))
                }
                "normalizeRecoverChatTagsResponse" => {
                    Ok(plain(normalize_recover_chat_tags_response(&value)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
