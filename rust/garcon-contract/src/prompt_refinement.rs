//! Ports `common/prompt-refinement.ts`.

use garcon_js::{trim, utf16};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{snippets::SNIPPET_TEMPLATE_MAX_LENGTH, tickets::TICKET_LIMITS};

pub const PROMPT_REFINEMENT_DRAFT_MAX_LENGTH: usize = 64_000;
pub const PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH: usize = 64_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptRefinementTarget {
    Prompt,
    SnippetTemplate,
    TicketDescription,
    TicketComment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefinePromptRequest {
    pub draft: String,
    pub target: PromptRefinementTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinePromptResponse {
    pub success: bool,
    pub refined_prompt: String,
}

pub fn is_prompt_refinement_target(value: &Value) -> Option<PromptRefinementTarget> {
    Some(match value.as_str()? {
        "prompt" => PromptRefinementTarget::Prompt,
        "snippet-template" => PromptRefinementTarget::SnippetTemplate,
        "ticket-description" => PromptRefinementTarget::TicketDescription,
        "ticket-comment" => PromptRefinementTarget::TicketComment,
        _ => return None,
    })
}

pub fn prompt_refinement_target_max_length(target: PromptRefinementTarget) -> usize {
    match target {
        PromptRefinementTarget::Prompt => PROMPT_REFINEMENT_DRAFT_MAX_LENGTH,
        PromptRefinementTarget::SnippetTemplate => SNIPPET_TEMPLATE_MAX_LENGTH,
        PromptRefinementTarget::TicketDescription | PromptRefinementTarget::TicketComment => {
            TICKET_LIMITS.body_bytes
        }
    }
}

pub fn prompt_refinement_target_output_max_length(target: PromptRefinementTarget) -> usize {
    match target {
        PromptRefinementTarget::Prompt => PROMPT_REFINEMENT_OUTPUT_MAX_LENGTH,
        PromptRefinementTarget::SnippetTemplate => SNIPPET_TEMPLATE_MAX_LENGTH,
        PromptRefinementTarget::TicketDescription | PromptRefinementTarget::TicketComment => {
            TICKET_LIMITS.body_bytes
        }
    }
}

pub fn normalize_refine_prompt_request(value: &Value) -> Option<RefinePromptRequest> {
    let raw = value.as_object()?;
    let draft = raw.get("draft")?.as_str()?;
    let target = is_prompt_refinement_target(raw.get("target")?)?;
    if trim(draft).is_empty()
        || utf16::len(draft) > prompt_refinement_target_max_length(target)
        || !fits_ticket_text(draft, target)
    {
        return None;
    }
    Some(RefinePromptRequest {
        draft: draft.to_owned(),
        target,
    })
}

pub fn normalize_refine_prompt_response(
    value: &Value,
    target: PromptRefinementTarget,
) -> Option<RefinePromptResponse> {
    let raw = value.as_object()?;
    if raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let refined_prompt = trim(raw.get("refinedPrompt")?.as_str()?);
    if refined_prompt.is_empty()
        || utf16::len(refined_prompt) > prompt_refinement_target_output_max_length(target)
        || !fits_ticket_text(refined_prompt, target)
    {
        return None;
    }
    Some(RefinePromptResponse {
        success: true,
        refined_prompt: refined_prompt.to_owned(),
    })
}

fn fits_ticket_text(text: &str, target: PromptRefinementTarget) -> bool {
    // Rust str is already well-formed after the JSON boundary.
    !matches!(
        target,
        PromptRefinementTarget::TicketDescription | PromptRefinementTarget::TicketComment
    ) || text.len() <= TICKET_LIMITS.body_bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounds_ticket_targets_by_utf8_bytes_on_both_sides() {
        let text = "\u{e9}".repeat(TICKET_LIMITS.body_bytes / 2);
        for target in [
            PromptRefinementTarget::TicketComment,
            PromptRefinementTarget::TicketDescription,
        ] {
            assert!(
                normalize_refine_prompt_request(&json!({"draft":text,"target":target})).is_some()
            );
            assert!(
                normalize_refine_prompt_request(
                    &json!({"draft":format!("{text}a"),"target":target})
                )
                .is_none()
            );
            assert!(
                normalize_refine_prompt_response(
                    &json!({"success":true,"refinedPrompt":text}),
                    target
                )
                .is_some()
            );
            assert!(
                normalize_refine_prompt_response(
                    &json!({"success":true,"refinedPrompt":format!("{text}a")}),
                    target
                )
                .is_none()
            );
            assert!(
                normalize_refine_prompt_request(&json!({"draft":"\u{fffd}","target":target}))
                    .is_some()
            );
        }
    }
}
