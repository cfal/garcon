use std::borrow::Cow;
use std::collections::HashSet;

use garcon_js::{Number, trim, utf16};
use indexmap::IndexMap;
use thiserror::Error;

use crate::{
    chat_types::{
        AssistantMessage, ChatMessage, CommandOutputChannel, ToolUseChatMessage, UserMessage,
    },
    command_output::CommandWorkingDirectory,
    transcript_notice_details::TranscriptNoticeDetail,
    transcript_projection::{
        PrioritizedProjectionEntry, ProjectionCost, ProjectionInput, projection_priority_level,
        select_prioritized_projection,
    },
};

use super::{
    CARRIED_CONTEXT_VERSION, CARRYOVER_INJECTION_MAX_CHARS, CarriedContext, CostedCarriedContext,
    RECENT_TURNS_VERBATIM, SEED_CONTEXT_CLOSE, SEED_CONTEXT_OPEN,
    summary::{
        PROJECTED_BODY_MAX_CHARS, bounded_collapse, collapse, legacy_tool_result,
        legacy_tool_summary, project_tool_use_summary, tool_name,
    },
    units::prefix,
};

const CARRIED_CONTEXT_PREAMBLE: &str =
    "Previous conversation context follows. Continue from it without repeating it.";
const TRUNCATION_ELEMENT: &str = "    <earlier-turns-truncated/>";
const PUBLICATION_GAP_ELEMENT: &str = "    <publication-gap>Some earlier output was not delivered. Retained command results do not establish complete output.</publication-gap>";
const CLOSING: &str = "  </transcript>\n</carried-context>\n\n";
const LEGACY_SEED_MAX_CHARS: f64 = 12_000.0;
const READ_LEVEL: usize = 2;
const EDIT_LEVEL: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("Carried-context budget must be at least {minimum} characters")]
pub struct CarriedContextBudgetTooSmall {
    pub minimum: usize,
}

pub struct ProjectionCostBudget<'a> {
    pub maximum_cost: f64,
    pub cost: &'a ProjectionCost<'a>,
}

pub fn create_carryover_transcript(
    messages: &[ChatMessage],
    max_chars: f64,
    summary: Option<&str>,
) -> Result<Option<CarriedContext>, CarriedContextBudgetTooSmall> {
    let Some(prepared) = prepare_projection(messages, summary) else {
        return Ok(None);
    };
    let full = prepared.full();
    if max_chars <= 0.0 || (utf16::len(&full) as f64) <= max_chars {
        return Ok(Some(CarriedContext {
            prefix: full,
            summary_truncated: None,
        }));
    }
    let minimum = utf16::len(&prepared.truncated_minimum());
    if minimum as f64 > max_chars {
        return Err(CarriedContextBudgetTooSmall { minimum });
    }

    let frame =
        utf16::len(&prepared.opening) + utf16::len(CLOSING) + 3 + utf16::len(TRUNCATION_ELEMENT);
    let reserved = if prepared.entries.is_empty() {
        0
    } else {
        utf16::len(&prepared.body) + 1
    };
    let fitted_summary = nonempty(summary).map_or_else(String::new, |summary| {
        fit_element(
            "    <summary>",
            trim(summary),
            "</summary>",
            nonnegative(max_chars - frame as f64 - reserved as f64),
        )
    });
    let lead = summary_lead(&fitted_summary);
    let available = nonnegative(
        max_chars
            - utf16::len(&prepared.opening) as f64
            - utf16::len(CLOSING) as f64
            - 2.0
            - utf16::len(&lead) as f64,
    );
    let selection = prepared.select(available, utf16::len(TRUNCATION_ELEMENT) as f64, &|text| {
        (utf16::len(text) + 1) as f64
    });
    Ok(Some(CarriedContext {
        prefix: prepared.truncated(&lead, selection.0),
        summary_truncated: Some(fitted_summary != prepared.summary_element),
    }))
}

pub fn create_carryover_transcript_within_cost(
    messages: &[ChatMessage],
    budget: ProjectionCostBudget<'_>,
    summary: Option<&str>,
) -> Option<CostedCarriedContext> {
    let ProjectionCostBudget { maximum_cost, cost } = budget;
    if !maximum_cost.is_finite() || maximum_cost <= 0.0 {
        return None;
    }
    let prepared = prepare_projection(messages, summary)?;
    let full = prepared.full();
    let full_cost = cost(&full);
    if full_cost <= maximum_cost {
        return Some(CostedCarriedContext {
            context: CarriedContext {
                prefix: full,
                summary_truncated: None,
            },
            admission_cost: Number(full_cost),
        });
    }
    if cost(&prepared.truncated_minimum()) > maximum_cost {
        return None;
    }
    let fitted_summary = nonempty(summary).map_or_else(String::new, |summary| {
        fit_element_within_cost(
            "    <summary>",
            trim(summary),
            "</summary>",
            maximum_cost,
            &|element| {
                let opening = &prepared.opening;
                let body_prefix = if prepared.body.is_empty() { "" } else { "\n" };
                cost(&format!(
                    "{opening}\n{element}\n{TRUNCATION_ELEMENT}{body_prefix}{}\n{CLOSING}",
                    prepared.body
                ))
            },
            None,
        )
    });
    let lead = summary_lead(&fitted_summary);
    let fixed_document = format!("{}\n{lead}{CLOSING}", prepared.opening);
    let available = nonnegative(maximum_cost - cost(&fixed_document));
    let (selected, admission_cost) = prepared.select(
        available,
        cost(&format!("{TRUNCATION_ELEMENT}\n")),
        &|text| cost(&format!("{text}\n")),
    );
    Some(CostedCarriedContext {
        context: CarriedContext {
            prefix: prepared.truncated(&lead, selected),
            summary_truncated: Some(fitted_summary != prepared.summary_element),
        },
        admission_cost: Number(cost(&fixed_document) + admission_cost),
    })
}

pub fn render_carried_context(
    messages: &[ChatMessage],
    max_chars: Option<f64>,
) -> Result<Option<CarriedContext>, CarriedContextBudgetTooSmall> {
    create_carryover_transcript(
        messages,
        max_chars.unwrap_or(CARRYOVER_INJECTION_MAX_CHARS as f64),
        None,
    )
}

fn nonempty(summary: Option<&str>) -> Option<&str> {
    summary.filter(|summary| !summary.is_empty())
}

fn nonnegative(value: f64) -> f64 {
    if value < 0.0 { 0.0 } else { value }
}

fn summary_lead(element: &str) -> String {
    if element.is_empty() {
        String::new()
    } else {
        format!("{element}\n")
    }
}

struct PreparedProjection {
    opening: String,
    summary_element: String,
    entries: Vec<SeedEntry>,
    body: String,
    turn_count: usize,
}

impl PreparedProjection {
    fn full(&self) -> String {
        if self.entries.is_empty() {
            format!("{}\n{}\n{CLOSING}", self.opening, self.summary_element)
        } else {
            format!(
                "{}\n{}{}\n{CLOSING}",
                self.opening,
                summary_lead(&self.summary_element),
                self.body
            )
        }
    }

    fn truncated_minimum(&self) -> String {
        format!("{}\n{TRUNCATION_ELEMENT}\n{CLOSING}", self.opening)
    }

    fn select(
        &self,
        maximum_cost: f64,
        truncation_marker_cost: f64,
        cost: &ProjectionCost<'_>,
    ) -> (String, f64) {
        let entries: Vec<_> = self.entries.iter().collect();
        let result = select_prioritized_projection(ProjectionInput {
            entries: &entries,
            turn_count: self.turn_count as f64,
            maximum_cost,
            truncation_marker_cost,
            cost,
            recent_turns_verbatim: Some(RECENT_TURNS_VERBATIM as f64),
        });
        let mut selected = String::new();
        for entry in result.selected {
            selected.push('\n');
            selected.push_str(&entry.text);
        }
        (selected, result.admission_cost.0)
    }

    fn truncated(&self, lead: &str, selected: String) -> String {
        format!(
            "{}\n{lead}{TRUNCATION_ELEMENT}{selected}\n{CLOSING}",
            self.opening
        )
    }
}

fn prepare_projection(
    messages: &[ChatMessage],
    summary: Option<&str>,
) -> Option<PreparedProjection> {
    let mut publication_gap = false;
    let mut turns: Vec<Vec<&ChatMessage>> = Vec::new();
    for message in messages {
        if is_publication_gap_message(message) {
            publication_gap = true;
        } else if is_projectable_message(message) {
            if matches!(message, ChatMessage::User(_)) || turns.is_empty() {
                turns.push(vec![message]);
            } else {
                // INFALLIBLE: the empty case pushes a new turn above.
                turns
                    .last_mut()
                    .expect("a projected turn exists")
                    .push(message);
            }
        }
    }
    let summary_element = nonempty(summary).map_or_else(String::new, |summary| {
        render_element("    <summary>", trim(summary), "</summary>")
    });
    let mut entries = Vec::new();
    for (index, turn) in turns.iter().enumerate() {
        render_turn(turn, index, &mut entries);
    }
    if entries.is_empty() && summary_element.is_empty() && !publication_gap {
        return None;
    }
    let mut opening = format!(
        "<carried-context version=\"{CARRIED_CONTEXT_VERSION}\">\n  <instructions>{CARRIED_CONTEXT_PREAMBLE}</instructions>\n  <transcript>"
    );
    if publication_gap {
        opening.push('\n');
        opening.push_str(PUBLICATION_GAP_ELEMENT);
    }
    let body = entries
        .iter()
        .map(|entry| entry.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Some(PreparedProjection {
        opening,
        summary_element,
        entries,
        body,
        turn_count: turns.len(),
    })
}

fn render_turn(turn: &[&ChatMessage], index: usize, entries: &mut Vec<SeedEntry>) {
    let mut reads = Vec::new();
    let mut seen_reads = HashSet::new();
    let mut edits = IndexMap::<&str, usize>::new();
    for message in turn {
        if let ChatMessage::ToolUse(tool) = message {
            use ToolUseChatMessage::*;
            match tool {
                Read { file_path, .. } if !file_path.is_empty() => {
                    if seen_reads.insert(file_path) {
                        reads.push(file_path.as_str());
                    }
                    continue;
                }
                Edit {
                    file_path, changes, ..
                } => {
                    if let Some(path) = nonempty(file_path.as_deref()) {
                        *edits.entry(path).or_default() += 1;
                        continue;
                    }
                    if let Some(changes) = changes {
                        let mut found = false;
                        for path in changes
                            .iter()
                            .filter_map(|change| nonempty(change.path.as_deref()))
                        {
                            *edits.entry(path).or_default() += 1;
                            found = true;
                        }
                        if found {
                            continue;
                        }
                    }
                }
                Write { file_path, .. } if !file_path.is_empty() => {
                    *edits.entry(file_path.as_str()).or_default() += 1;
                    continue;
                }
                ApplyPatch { file_path, .. } => {
                    if let Some(path) = nonempty(file_path.as_deref()) {
                        *edits.entry(path).or_default() += 1;
                        continue;
                    }
                }
                _ => {}
            }
        }
        if let Some(entry) = render_message(message, index) {
            entries.push(entry);
        }
    }
    if !reads.is_empty() {
        entries.push(SeedEntry::new(
            index,
            READ_LEVEL,
            "    <files-read>",
            reads.join(", "),
            "</files-read>",
            None,
        ));
    }
    if !edits.is_empty() {
        let content = edits
            .into_iter()
            .map(|(path, count)| {
                if count > 1 {
                    Cow::Owned(format!("{path} ({count} edits)"))
                } else {
                    Cow::Borrowed(path)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        entries.push(SeedEntry::new(
            index,
            EDIT_LEVEL,
            "    <files-edited>",
            content,
            "</files-edited>",
            None,
        ));
    }
}

struct SeedEntry {
    level: usize,
    turn: usize,
    open: &'static str,
    content: String,
    close: &'static str,
    refit_prefix: Option<String>,
    text: String,
}

impl SeedEntry {
    fn new(
        turn: usize,
        level: usize,
        open: &'static str,
        content: String,
        close: &'static str,
        refit_prefix: Option<String>,
    ) -> Self {
        Self {
            level,
            turn,
            open,
            close,
            text: render_element(open, &content, close),
            content,
            refit_prefix,
        }
    }
}

impl PrioritizedProjectionEntry for SeedEntry {
    fn level(&self) -> usize {
        self.level
    }
    fn turn(&self) -> f64 {
        self.turn as f64
    }
    fn text(&self) -> &str {
        &self.text
    }
    fn refit(&self, maximum_cost: f64, cost: &ProjectionCost<'_>) -> String {
        fit_element_within_cost(
            self.open,
            &self.content,
            self.close,
            maximum_cost,
            cost,
            self.refit_prefix.as_deref(),
        )
    }
}

fn render_message(message: &ChatMessage, turn: usize) -> Option<SeedEntry> {
    use ChatMessage::*;
    let (message_type, open, content, close) = match message {
        ToolUse(tool) => {
            let summary = project_tool_use_summary(tool, None);
            let name = tool_name(tool);
            let content = if summary.text.is_empty() {
                name.to_owned()
            } else {
                format!("{name}: {}", summary.text)
            };
            let refit_prefix = summary
                .prefix_before_literal
                .map(|prefix| format!("{name}: {prefix}"));
            return Some(SeedEntry::new(
                turn,
                projection_priority_level(tool.message_type()),
                "    <assistant><tool-use>",
                content,
                "</tool-use></assistant>",
                refit_prefix,
            ));
        }
        User(user) if literal(user) => {
            let content = utf16::truncate(&user.content, PROJECTED_BODY_MAX_CHARS);
            let bounded = if content == user.content {
                content.to_owned()
            } else {
                format!("{content}...")
            };
            (
                UserMessage::TYPE,
                "    <user content-mode=\"literal\">",
                bounded,
                "</user>",
            )
        }
        User(user) => (
            UserMessage::TYPE,
            "    <user>",
            bounded_collapse(&user.content),
            "</user>",
        ),
        Assistant(message) => (
            AssistantMessage::TYPE,
            "    <assistant>",
            bounded_collapse(&message.content),
            "</assistant>",
        ),
        CommandOutput(message) => {
            let channel = match message.channel {
                CommandOutputChannel::Stdout => "stdout",
                CommandOutputChannel::Stderr => "stderr",
            };
            let mut content = format!("{channel}: {}", message.content);
            if let Some(context) = &message.context {
                content.push_str(&format!(
                    "\nExecutor: {}\nStarting directory: {}",
                    context.executor_id, context.project_path
                ));
            }
            (
                "command-output",
                "    <execution-output>",
                content,
                "</execution-output>",
            )
        }
        CommandResult(message) => {
            let mut content = format!("Command result: {}", message.content);
            if let CommandWorkingDirectory::Reported { path } = &message.result.cwd {
                content.push_str(&format!("\nWorking directory: {path}"));
            }
            (
                "command-result",
                "    <execution-output>",
                content,
                "</execution-output>",
            )
        }
        _ => return None,
    };
    Some(SeedEntry::new(
        turn,
        projection_priority_level(message_type),
        open,
        content,
        close,
        None,
    ))
}

fn literal(message: &UserMessage) -> bool {
    message
        .metadata
        .as_ref()
        .is_some_and(|metadata| metadata.content_mode.is_some())
}

pub fn is_projectable_message(message: &ChatMessage) -> bool {
    matches!(
        message,
        ChatMessage::User(_)
            | ChatMessage::Assistant(_)
            | ChatMessage::CommandOutput(_)
            | ChatMessage::CommandResult(_)
            | ChatMessage::ToolUse(_)
    ) || is_publication_gap_message(message)
}

pub fn is_publication_gap_message(message: &ChatMessage) -> bool {
    matches!(message, ChatMessage::Notice(notice) if matches!(notice.detail, Some(TranscriptNoticeDetail::PublicationGap)))
}

pub fn bound_projected_message(message: ChatMessage) -> ChatMessage {
    match message {
        ChatMessage::User(mut user)
            if utf16::len(&user.content) > PROJECTED_BODY_MAX_CHARS
                || user
                    .images
                    .as_ref()
                    .is_some_and(|images| !images.is_empty()) =>
        {
            let cap = PROJECTED_BODY_MAX_CHARS + usize::from(literal(&user));
            user.content = prefix(&user.content, cap).into_owned();
            user.images = None;
            ChatMessage::User(user)
        }
        ChatMessage::Assistant(mut message)
            if utf16::len(&message.content) > PROJECTED_BODY_MAX_CHARS =>
        {
            message.content = prefix(&message.content, PROJECTED_BODY_MAX_CHARS).into_owned();
            message.questions = None;
            ChatMessage::Assistant(message)
        }
        message => message,
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_element(open: &str, content: &str, close: &str) -> String {
    format!("{open}{}{close}", escape_xml(content))
}

fn fit_element(open: &str, content: &str, close: &str, maximum: f64) -> String {
    let overhead = utf16::len(open) + utf16::len(close);
    if maximum < overhead as f64 {
        return String::new();
    }
    let escaped = escape_xml(content);
    if (overhead + utf16::len(&escaped)) as f64 <= maximum {
        return format!("{open}{escaped}{close}");
    }
    if maximum < (overhead + 3) as f64 {
        return String::new();
    }
    let prefix = fitted_prefix(content, |candidate| {
        (overhead + utf16::len(&escape_xml(candidate)) + 3) as f64 <= maximum
    });
    format!("{open}{}...{close}", escape_xml(prefix))
}

fn fit_element_within_cost(
    open: &str,
    content: &str,
    close: &str,
    maximum_cost: f64,
    cost: &ProjectionCost<'_>,
    refit_prefix: Option<&str>,
) -> String {
    let full = render_element(open, content, close);
    if cost(&full) <= maximum_cost {
        return full;
    }
    if cost(&format!("{open}...{close}")) > maximum_cost {
        return String::new();
    }
    let prefix = fitted_prefix(refit_prefix.unwrap_or(content), |candidate| {
        cost(&format!("{open}{}...{close}", escape_xml(candidate))) <= maximum_cost
    });
    format!("{open}{}...{close}", escape_xml(prefix))
}

fn fitted_prefix(content: &str, fits: impl Fn(&str) -> bool) -> &str {
    let offsets: Vec<_> = content
        .char_indices()
        .map(|(index, _)| index)
        .chain([content.len()])
        .collect();
    let mut low = 0;
    let mut high = offsets.len() - 1;
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if fits(&content[..offsets[middle]]) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    &content[..offsets[low]]
}

pub fn render_transcript_seed(
    messages: &[ChatMessage],
    max_chars: Option<f64>,
    from_agent_label: Option<&str>,
) -> String {
    let lines: Vec<_> = messages
        .iter()
        .filter_map(|message| {
            Some(match message {
                ChatMessage::ToolUse(tool) => format!(
                    "Assistant used {}: {}",
                    tool_name(tool),
                    legacy_tool_summary(tool)
                ),
                ChatMessage::User(user) => format!("User: {}", collapse(&user.content)),
                ChatMessage::Assistant(assistant) => {
                    format!("Assistant: {}", collapse(&assistant.content))
                }
                ChatMessage::ToolResult(result) => format!(
                    "Tool result: {}",
                    collapse(&legacy_tool_result(&result.content))
                ),
                _ => return None,
            })
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    let max_chars = max_chars.unwrap_or(LEGACY_SEED_MAX_CHARS);
    let mut first = 0;
    if max_chars > 0.0 {
        let mut total = 0;
        for (index, line) in lines.iter().enumerate().rev() {
            let cost = utf16::len(line) + usize::from(index + 1 < lines.len());
            if index + 1 < lines.len() && (total + cost) as f64 > max_chars {
                break;
            }
            total += cost;
            first = index;
        }
    }
    let from = nonempty(from_agent_label).unwrap_or("another assistant");
    let truncated = if first == 0 {
        ""
    } else {
        "[earlier turns truncated]\n"
    };
    format!(
        "The following is a prior conversation with {from}. Continue it.\n{SEED_CONTEXT_OPEN}\n{truncated}{}\n{SEED_CONTEXT_CLOSE}",
        lines[first..].join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn never_lets_a_summary_crowd_out_the_newest_request() {
        let messages = [user("Synthetic newest request.".to_owned())];
        let summary = "&<summary>".repeat(500);
        let carried = create_carryover_transcript(&messages, 400.0, Some(&summary))
            .unwrap()
            .unwrap();
        assert_eq!(carried.summary_truncated, Some(true));
        assert!(
            carried
                .prefix
                .contains("<user>Synthetic newest request.</user>")
        );
        assert!(utf16::len(&carried.prefix) <= 400);
        assert!(carried.prefix.contains("&amp;&lt;summary&gt;"));
    }

    #[test]
    fn returns_no_measured_projection_when_its_minimal_envelope_cannot_fit() {
        let messages = [user("<bounded output>".repeat(100))];
        let budget = ProjectionCostBudget {
            maximum_cost: 30.0,
            cost: &|text| utf16::len(text) as f64,
        };
        assert!(create_carryover_transcript_within_cost(&messages, budget, None).is_none());
        assert!(create_carryover_transcript(&messages, 30.0, None).is_err());
    }
}
