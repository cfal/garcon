//! Ports `server-agents/antigravity/src/agents/antigravity/tool-call-snapshot.ts`.

use std::ops::{Deref, DerefMut};
use std::rc::Rc;

use garcon_agents_common::acp::event_converter::as_object;
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_contract::tool_result_message::{ToolResultMessage, tool_result_text_part};
use garcon_js::json::{Opaque, as_number};
use garcon_js::trim;
use serde_json::{Map, Value};

use crate::plan_schedule_result::plan_or_schedule_result;
use crate::report_text::{prefers_report_content, raw_output_text};
use crate::tool_use_converter::{
    AntigravityToolCall, PlanTitle, antigravity_mcp_arguments, antigravity_tool_name,
    antigravity_tool_result_text, reports_plan_or_schedule,
};

#[derive(Debug, Clone)]
pub struct TrackedCall {
    pub call: AntigravityToolCall,
    pub raw_output: Option<Rc<Opaque>>,
    pub content: Option<Rc<Vec<Value>>>,
    pub content_is_newer: bool,
    pub report_content_is_newer: bool,
}

impl TrackedCall {
    pub fn output(&self) -> Option<&Value> {
        self.raw_output.as_deref().map(Opaque::as_value)
    }

    pub fn blocks(&self) -> &[Value] {
        self.content.as_deref().map_or(&[][..], Vec::as_slice)
    }
}

impl Deref for TrackedCall {
    type Target = AntigravityToolCall;

    fn deref(&self) -> &Self::Target {
        &self.call
    }
}

impl DerefMut for TrackedCall {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.call
    }
}

fn is_agent_work(name: Option<&str>) -> bool {
    matches!(name, Some("manage_task" | "update_steps" | "send_message"))
}

fn is_structured_output(raw: Option<&Value>) -> bool {
    match raw {
        None | Some(Value::Null | Value::String(_)) => false,
        Some(Value::Object(fields)) => fields
            .iter()
            .any(|(key, value)| key != "output" || !value.is_string()),
        _ => true,
    }
}

fn join_block_text<'a>(blocks: impl IntoIterator<Item = &'a Value>) -> String {
    blocks
        .into_iter()
        .filter_map(|block| block.get("content")?.get("text")?.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn without_output_echoes<'a>(blocks: &'a [Value], output: &str) -> Vec<&'a Value> {
    let trimmed_output = trim(output);
    blocks
        .iter()
        .filter(|block| {
            output.is_empty()
                || tool_result_text_part(block).is_none_or(|part| {
                    part.text != output
                        && (trimmed_output.is_empty() || trim(part.text) != trimmed_output)
                })
        })
        .collect()
}

fn same_raw(a: Option<&Rc<Opaque>>, b: Option<&Rc<Opaque>>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            Rc::ptr_eq(a, b)
                || (!(a.is_array() || a.is_object() || b.is_array() || b.is_object())
                    && a.as_value() == b.as_value())
        }
        _ => false,
    }
}

fn same_content(a: Option<&Rc<Vec<Value>>>, b: Option<&Rc<Vec<Value>>>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => Rc::ptr_eq(a, b),
        _ => false,
    }
}

fn prefers_content(
    previous: Option<&TrackedCall>,
    raw: Option<&Rc<Opaque>>,
    content: Option<&Rc<Vec<Value>>>,
) -> bool {
    let previous_raw = previous.and_then(|previous| previous.raw_output.as_ref());
    let previous_content = previous.and_then(|previous| previous.content.as_ref());
    let was_newer = previous.is_some_and(|previous| previous.content_is_newer);
    let raw_unchanged = same_raw(raw, previous_raw);
    let content_unchanged = same_content(content, previous_content);
    if raw_unchanged && content_unchanged {
        return was_newer;
    }
    let raw = raw.map(|raw| raw.as_value());
    let prior_raw = previous.and_then(TrackedCall::output);
    let output = raw_output_text(raw);
    let output_changed = output != raw_output_text(prior_raw);
    if let Some(content) = content.filter(|_| !content_unchanged) {
        let old_blocks = previous.map_or(&[][..], TrackedCall::blocks);
        let before = without_output_echoes(old_blocks, output);
        let after = without_output_echoes(content, output);
        let has_output_text = !trim(output).is_empty();
        if has_output_text && after.len() < content.len() && before.len() == old_blocks.len() {
            return false;
        }
        if join_block_text(before) != join_block_text(after) {
            return !(output_changed && has_output_text);
        }
    }
    let raw_changed =
        output_changed || (!raw_unchanged && is_structured_output(raw) && raw != prior_raw);
    !raw_changed && was_newer
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Primary {
    Output,
    Metadata,
    Content,
}

fn agent_work_result(call: &TrackedCall, status: &str) -> Opaque {
    let raw_output = call.output();
    let output = raw_output_text(raw_output);
    let blocks = without_output_echoes(call.blocks(), output);
    let block_text = join_block_text(blocks.iter().copied());
    let trimmed_output = trim(output);
    let trimmed_blocks = trim(&block_text);
    let distinct = !trimmed_output.is_empty()
        && !trimmed_blocks.is_empty()
        && trimmed_output != trimmed_blocks;
    let structured = is_structured_output(raw_output);
    let primary = if !trimmed_output.is_empty() && !(distinct && call.content_is_newer) {
        Primary::Output
    } else if structured && trimmed_output.is_empty() && !call.content_is_newer {
        Primary::Metadata
    } else {
        Primary::Content
    };

    let mut result = Map::new();
    if status != "completed" {
        result.insert("status".to_owned(), Value::from(status));
    }
    if let Some(raw) =
        raw_output.filter(|_| structured || (distinct && primary == Primary::Content))
    {
        result.insert("rawOutput".to_owned(), raw.clone());
    }
    let keep_text = primary == Primary::Metadata || (primary == Primary::Output && distinct);
    let items: Vec<_> = blocks
        .into_iter()
        .filter(|block| {
            keep_text || block["type"] != "content" || block["content"]["type"] != "text"
        })
        .cloned()
        .collect();
    if !items.is_empty() {
        result.insert("items".to_owned(), Value::Array(items));
    }
    if primary == Primary::Output && !structured {
        result.insert("raw".to_owned(), Value::from(output));
    }
    if primary == Primary::Content && !trimmed_blocks.is_empty() {
        result.insert("raw".to_owned(), Value::from(block_text));
    }
    Value::Object(result).into()
}

pub fn tool_call_result(
    timestamp: &str,
    call: &TrackedCall,
    terminal: &Map<String, Value>,
    status: &str,
    previous: Option<&TrackedCall>,
) -> ToolResultMessage {
    let name = (!call.is_mcp)
        .then(|| antigravity_tool_name(call))
        .flatten();
    if reports_plan_or_schedule(name) {
        return plan_or_schedule_result(timestamp, call, previous, terminal, status);
    }
    if is_agent_work(name) {
        return ToolResultMessage::new(
            timestamp.to_owned(),
            call.tool_call_id.clone(),
            agent_work_result(call, status),
            status != "completed",
            None,
        );
    }
    let output = terminal
        .get("rawOutput")
        .and_then(|output| output.get("output"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fallback;
    let text = if trim(output).is_empty() {
        let blocks = if terminal.get("content").is_some_and(Value::is_array) {
            call.blocks()
        } else {
            &[][..]
        };
        fallback = join_block_text(blocks);
        fallback.as_str()
    } else {
        output
    };
    let text = antigravity_tool_result_text(name.unwrap_or_default(), text);
    let exit_code = if name == Some("run_command") {
        call.output().and_then(|output| output.get("exit_code"))
    } else {
        None
    };
    let failed = exit_code
        .and_then(as_number)
        .is_some_and(|code| code != 0.0);
    let content = if !trim(text).is_empty() {
        Map::from_iter([("raw".to_owned(), Value::from(text))])
    } else if let Some(code) = exit_code.filter(|_| failed) {
        Map::from_iter([("exitCode".to_owned(), code.clone())])
    } else if status != "completed" {
        Map::from_iter([("status".to_owned(), Value::from(status))])
    } else {
        Map::new()
    };
    ToolResultMessage::new(
        timestamp.to_owned(),
        call.tool_call_id.clone(),
        Value::Object(content).into(),
        failed || status != "completed",
        None,
    )
}

fn has_string(input: &Map<String, Value>, key: &str) -> bool {
    input
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

fn accepts_partial_input(name: Option<&str>, input: &Map<String, Value>) -> bool {
    is_agent_work(name)
        || reports_plan_or_schedule(name)
        || name == Some("call_mcp_tool")
        || has_string(input, "server")
        || has_string(input, "tool")
}

fn merge_arguments(
    previous: Option<&TrackedCall>,
    call: &AntigravityToolCall,
    name: Option<&str>,
) -> (Map<String, Value>, Option<Opaque>) {
    if !call.input.is_empty() {
        let previous_is_partial = previous.filter(|previous| {
            previous.name.as_deref().is_none_or(str::is_empty)
                || call.is_mcp
                || previous.is_mcp
                || accepts_partial_input(name, &previous.input)
        });
        let mut input = previous_is_partial
            .map(|previous| previous.input.clone())
            .unwrap_or_default();
        input.extend(call.input.clone());
        return (input.clone(), Some(Value::Object(input).into()));
    }
    let input = previous.map_or_else(|| call.input.clone(), |previous| previous.input.clone());
    if name.is_none() || reports_plan_or_schedule(name) {
        if call.raw_input.as_ref().is_some_and(|raw| !raw.is_object()) {
            return (input, call.raw_input.clone());
        }
        if let Some(previous) = previous {
            return (input, previous.raw_input.clone());
        }
    }
    (input.clone(), Some(Value::Object(input).into()))
}

pub fn merge_call(
    previous: Option<&TrackedCall>,
    mut call: AntigravityToolCall,
    update: Option<&Map<String, Value>>,
) -> TrackedCall {
    let select = |current: Option<String>, old: Option<&String>| {
        current
            .filter(|value| !value.is_empty())
            .or_else(|| old.filter(|value| !value.is_empty()).cloned())
    };
    let name = select(
        call.name.take(),
        previous.and_then(|previous| previous.name.as_ref()),
    );
    let (input, raw_input) = merge_arguments(previous, &call, name.as_deref());
    let raw_output = update
        .and_then(|update| update.get("rawOutput"))
        .filter(|raw| !raw.is_null())
        .map(|raw| Rc::new(raw.clone().into()))
        .or_else(|| previous.and_then(|previous| previous.raw_output.clone()));
    let content = update
        .and_then(|update| update.get("content"))
        .and_then(Value::as_array)
        .map(|content| {
            Rc::new(
                content
                    .iter()
                    .map(as_object)
                    .filter(|block| block.get("type").and_then(Value::as_str) != Some("diff"))
                    .map(|block| Value::Object(block.clone()))
                    .collect(),
            )
        })
        .or_else(|| previous.and_then(|previous| previous.content.clone()));
    let is_mcp = call.is_mcp
        || previous.is_some_and(|previous| previous.is_mcp)
        || (has_string(&input, "server") && has_string(&input, "tool"));
    let content_is_newer = prefers_content(previous, raw_output.as_ref(), content.as_ref());
    let report_content_is_newer = !is_mcp
        && (name.is_none() || reports_plan_or_schedule(name.as_deref()))
        && prefers_report_content(
            previous,
            raw_output.as_deref().map(Opaque::as_value),
            content.as_ref(),
        );
    let previous_plan_title = previous.and_then(|previous| previous.plan_title);
    call.name = name;
    call.kind = select(
        call.kind,
        previous.and_then(|previous| previous.kind.as_ref()),
    );
    call.is_mcp = is_mcp;
    call.plan_title = if previous_plan_title == Some(PlanTitle::Excluded) {
        previous_plan_title
    } else {
        call.plan_title.or(previous_plan_title)
    };
    call.input = input;
    call.raw_input = raw_input;
    TrackedCall {
        call,
        raw_output,
        content,
        content_is_newer,
        report_content_is_newer,
    }
}

pub fn needs_more_evidence(call: &TrackedCall, row: &ToolUseChatMessage) -> bool {
    if call.input.is_empty() {
        return true;
    }
    if matches!(row, ToolUseChatMessage::Mcp { .. }) {
        return antigravity_mcp_arguments(&call.input).is_none();
    }
    let name = call.name.as_deref().filter(|name| !name.is_empty());
    if call.is_mcp
        || name.is_none()
        || reports_plan_or_schedule(name)
        || has_string(&call.input, "server")
        || has_string(&call.input, "tool")
    {
        return true;
    }
    matches!(row, ToolUseChatMessage::External { .. }) && accepts_partial_input(name, &call.input)
}
