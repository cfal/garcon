//! Ports `common/ticket-chat.ts`.

use std::sync::LazyLock;

use garcon_js::{trim, utf16};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

use crate::generation_prompts::GENERATION_PROMPT_TEMPLATE_MAX_LENGTH;

pub const TICKET_CHAT_TOKENS: &[(&str, &str)] = &[
    ("id", "{{ticket_id}}"),
    ("title", "{{ticket_title}}"),
    ("project", "{{ticket_project}}"),
    ("description", "{{ticket_description}}"),
];

pub const TICKET_CHAT_PROMPT_MAX_LENGTH: usize = 256_000;

pub const DEFAULT_TICKET_CHAT_PROMPT: &str = r#"Work on the ticket below. Read the relevant code before making changes, keep the work focused, and verify the result. Use the available ticket tools to check its current status and ownership, claim it when appropriate, and keep its progress up to date. When finished, summarize the changes, verification, and anything still open.

Ticket {{ticket_id}}: {{ticket_title}}
Project label: {{ticket_project}}

{{ticket_description}}"#;

static VARIABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{[^{}]*\}\}").expect("valid ticket template token pattern"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketChatSubject {
    pub id: String,
    pub title: String,
    pub project: String,
    pub description: String,
}

impl TicketChatSubject {
    fn replacement(&self, token: &str) -> Option<&str> {
        match token {
            "{{ticket_id}}" => Some(&self.id),
            "{{ticket_title}}" => Some(&self.title),
            "{{ticket_project}}" => Some(&self.project),
            "{{ticket_description}}" => Some(&self.description),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TicketChatPromptError {
    TooLong,
    MissingTicketId,
    UnknownVariable,
}

pub fn ticket_chat_prompt_error(template: &str) -> Option<TicketChatPromptError> {
    if utf16::len(template) > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH {
        return Some(TicketChatPromptError::TooLong);
    }
    if trim(template).is_empty() {
        return None;
    }
    if !template.contains("{{ticket_id}}") {
        return Some(TicketChatPromptError::MissingTicketId);
    }
    VARIABLE
        .find_iter(template)
        .any(|found| {
            !TICKET_CHAT_TOKENS
                .iter()
                .any(|&(_, token)| token == found.as_str())
        })
        .then_some(TicketChatPromptError::UnknownVariable)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RenderTicketChatPromptError {
    #[error("The ticket chat prompt template is invalid. Update it in Settings.")]
    InvalidTemplate,
    #[error(
        "The expanded ticket chat prompt exceeds {TICKET_CHAT_PROMPT_MAX_LENGTH} characters. Shorten the template in Settings."
    )]
    ExpandedTooLong,
}

pub fn render_ticket_chat_prompt(
    template: Option<&str>,
    ticket: &TicketChatSubject,
) -> Result<String, RenderTicketChatPromptError> {
    let source = template
        .filter(|template| !trim(template).is_empty())
        .unwrap_or(DEFAULT_TICKET_CHAT_PROMPT);
    if ticket_chat_prompt_error(source).is_some() {
        return Err(RenderTicketChatPromptError::InvalidTemplate);
    }
    let mut length = 0usize;
    let mut previous_end = 0;
    for found in VARIABLE.find_iter(source) {
        let value = ticket
            .replacement(found.as_str())
            .ok_or(RenderTicketChatPromptError::InvalidTemplate)?;
        length = length
            .saturating_add(utf16::len(&source[previous_end..found.start()]))
            .saturating_add(utf16::len(value));
        if length > TICKET_CHAT_PROMPT_MAX_LENGTH {
            return Err(RenderTicketChatPromptError::ExpandedTooLong);
        }
        previous_end = found.end();
    }
    if length.saturating_add(utf16::len(&source[previous_end..])) > TICKET_CHAT_PROMPT_MAX_LENGTH {
        return Err(RenderTicketChatPromptError::ExpandedTooLong);
    }
    let rendered = VARIABLE.replace_all(source, |capture: &Captures<'_>| {
        ticket.replacement(&capture[0]).unwrap_or_default()
    });
    Ok(trim(&rendered).to_owned())
}
