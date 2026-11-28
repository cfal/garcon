//! Ports `server-agents/antigravity/src/agents/antigravity/plan-schedule-result.ts`.

use std::borrow::Cow;

use garcon_contract::tool_result_content::{plain_tool_result_text_part, tool_result_text_part};
use garcon_contract::tool_result_message::ToolResultMessage;
use garcon_js::trim;
use serde_json::{Map, Value};

use crate::report_text::{
    TextEcho, block_text, independent_text_indices, joined_report_text, primary_text_indices,
    raw_output_text, text_echoes, unique_echo,
};
use crate::tool_call_snapshot::TrackedCall;

fn plain_text(block: &Value) -> bool {
    plain_tool_result_text_part(block).is_some()
}

fn without_block_text(block: &Value) -> Option<Value> {
    let Some(part) = tool_result_text_part(block) else {
        return Some(block.clone());
    };
    if plain_text(block) {
        return None;
    }
    let mut metadata = part.raw.clone();
    metadata.insert("text".to_owned(), Value::from(""));
    if block["type"] != "content" {
        return Some(Value::Object(metadata));
    }
    let mut block = block.clone();
    block["content"] = Value::Object(metadata);
    Some(block)
}

fn cached_blocks_for_text(blocks: &[Value], output: &str) -> Vec<Value> {
    let echo = unique_echo(&text_echoes(blocks, output));
    blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            if echo.is_some_and(|echo| (echo.first..=echo.last).contains(&index)) {
                Some(block.clone())
            } else {
                without_block_text(block)
            }
        })
        .collect()
}

fn overlay_block(before: &Map<String, Value>, after: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = before.clone();
    merged.extend(after.clone());
    if let (Some(before), Some(after)) = (
        before.get("annotations").and_then(Value::as_object),
        after.get("annotations").and_then(Value::as_object),
    ) {
        let mut annotations = before.clone();
        annotations.extend(after.clone());
        merged.insert("annotations".to_owned(), Value::Object(annotations));
    }
    merged
}

fn overlay_text(before: &Value, after: &Value) -> Option<Value> {
    let part = overlay_block(
        tool_result_text_part(before)?.raw,
        tool_result_text_part(after)?.raw,
    );
    if before["type"] != "content" && after["type"] != "content" {
        return Some(Value::Object(part));
    }
    let empty = Map::new();
    let mut merged = overlay_block(
        wrapper(before).unwrap_or(&empty),
        wrapper(after).unwrap_or(&empty),
    );
    merged.insert("type".to_owned(), Value::from("content"));
    merged.insert("content".to_owned(), Value::Object(part));
    Some(Value::Object(merged))
}

fn wrapper(block: &Value) -> Option<&Map<String, Value>> {
    block
        .as_object()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("content"))
}

fn align_terminal_blocks(
    cached: &[Value],
    terminal: &[Value],
    echo: TextEcho,
) -> Option<Vec<Value>> {
    let mut result = Vec::new();
    let mut next = 0;
    for (index, block) in cached.iter().enumerate() {
        let before = tool_result_text_part(block);
        if !(echo.first..=echo.last).contains(&index) {
            if before.is_some_and(|before| before.text.is_empty())
                && terminal.get(next) == Some(block)
            {
                result.push(terminal[next].clone());
                next += 1;
            } else {
                result.extend(without_block_text(block));
            }
            continue;
        }
        let Some(before) = before.filter(|part| !part.text.is_empty()) else {
            if tool_result_text_part(block).is_some() && terminal.get(next) == Some(block) {
                result.push(terminal[next].clone());
                next += 1;
            } else if !plain_text(block) {
                result.push(block.clone());
            }
            continue;
        };
        let comparable: fn(&str) -> &str = if trim(before.text).is_empty() {
            |text| text
        } else {
            trim
        };
        while let Some(block) = terminal
            .get(next)
            .filter(|block| comparable(block_text(block)).is_empty())
        {
            result.push(block.clone());
            next += 1;
        }
        let reported = terminal.get(next)?;
        next += 1;
        let after = tool_result_text_part(reported)?;
        if comparable(after.text) != comparable(before.text) {
            return None;
        }
        result.push(overlay_text(block, reported)?);
    }
    for block in &terminal[next..] {
        if !trim(block_text(block)).is_empty() {
            return None;
        }
        result.push(block.clone());
    }
    Some(result)
}

fn report_blocks<'a>(
    cached: &'a [Value],
    terminal: &'a [Value],
    terminal_text: &str,
    output: &str,
) -> Cow<'a, [Value]> {
    if !terminal.is_empty() && cached == terminal {
        return Cow::Borrowed(terminal);
    }
    let cached = if terminal
        .iter()
        .any(|block| tool_result_text_part(block).is_none())
    {
        Cow::Owned(
            cached
                .iter()
                .filter(|block| tool_result_text_part(block).is_some())
                .cloned()
                .collect::<Vec<_>>(),
        )
    } else {
        Cow::Borrowed(cached)
    };
    if !terminal_text.is_empty() {
        if cached.iter().all(plain_text) {
            return Cow::Borrowed(terminal);
        }
        if let Some(echo) = unique_echo(&text_echoes(&cached, terminal_text))
            && let Some(aligned) = align_terminal_blocks(&cached, terminal, echo)
        {
            return Cow::Owned(aligned);
        }
        return Cow::Owned(
            cached
                .iter()
                .filter_map(without_block_text)
                .chain(terminal.iter().cloned())
                .collect(),
        );
    }
    let retained = if output.is_empty() {
        cached
    } else {
        Cow::Owned(cached_blocks_for_text(&cached, output))
    };
    if terminal.iter().all(plain_text) {
        return if retained.is_empty() {
            Cow::Borrowed(terminal)
        } else {
            retained
        };
    }
    let mut combined = retained.into_owned();
    combined.extend_from_slice(terminal);
    Cow::Owned(combined)
}

fn metadata(raw: Option<&Value>) -> Option<Value> {
    let raw = raw?;
    if raw.is_null() || raw.is_string() {
        return None;
    }
    let Some(fields) = raw.as_object() else {
        return Some(raw.clone());
    };
    let mut fields = fields.clone();
    if fields.get("output").is_some_and(Value::is_string) {
        fields.shift_remove("output");
    }
    (!fields.is_empty()).then_some(Value::Object(fields))
}

fn merge_metadata(cached: Option<Value>, terminal: Option<Value>) -> Option<Value> {
    match (cached, terminal) {
        (Some(Value::Object(mut cached)), Some(Value::Object(terminal))) => {
            cached.extend(terminal);
            Some(Value::Object(cached))
        }
        (cached, terminal) => terminal.or(cached),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Placement {
    Standalone,
    WithBlocks,
}

fn store_output(
    body: &mut Map<String, Value>,
    raw: Option<&Value>,
    fields: Option<&Value>,
    placement: Placement,
) {
    let text = raw_output_text(raw);
    if let Some(fields) = fields {
        body.insert("rawOutput".to_owned(), fields.clone());
    }
    if trim(text).is_empty() {
        return;
    }
    if let Some(fields) = fields
        .and_then(Value::as_object)
        .filter(|fields| !fields.contains_key("output"))
    {
        let mut output = Map::from_iter([("output".to_owned(), Value::from(text))]);
        output.extend(fields.clone());
        body.insert("rawOutput".to_owned(), Value::Object(output));
    } else if let Some(raw) = raw.filter(|_| fields.is_none() && placement == Placement::WithBlocks)
    {
        body.insert("rawOutput".to_owned(), raw.clone());
    } else {
        body.insert("raw".to_owned(), Value::from(text));
    }
}

pub fn plan_or_schedule_result(
    timestamp: &str,
    call: &TrackedCall,
    previous: Option<&TrackedCall>,
    terminal: &Map<String, Value>,
    status: &str,
) -> ToolResultMessage {
    let frame = if terminal.get("content").is_some_and(Value::is_array) {
        call.blocks()
    } else {
        &[][..]
    };
    let frame_text = joined_report_text(frame);
    let frame_text = trim(&frame_text);
    let frame_raw = terminal.get("rawOutput");
    let frame_output = trim(raw_output_text(frame_raw));
    let cached_output = previous.and_then(TrackedCall::output);
    let (raw, output) = if frame_output.is_empty() {
        (cached_output, trim(raw_output_text(cached_output)))
    } else {
        (frame_raw, frame_output)
    };
    let terminal_metadata = metadata(frame_raw);
    let has_terminal_metadata = terminal_metadata.is_some();
    let fields = merge_metadata(metadata(cached_output), terminal_metadata);
    let blocks = report_blocks(
        previous.map_or(&[][..], TrackedCall::blocks),
        frame,
        frame_text,
        frame_output,
    );
    let echoes = text_echoes(&blocks, output);
    let echo = unique_echo(&echoes);
    let text = joined_report_text(&blocks);
    let use_cache = frame_text.is_empty() && frame_output.is_empty();
    let blocks_only = !frame_text.is_empty() && frame_output.is_empty();
    let prefer_blocks = if use_cache {
        previous.is_some_and(|previous| previous.report_content_is_newer)
    } else {
        !frame_text.is_empty() && call.report_content_is_newer
    };
    let separate_output = echo.is_none() && !blocks_only && !output.is_empty();
    let keep_ordered = (echo.is_some() && trim(&text) != output)
        || (prefer_blocks && (echoes.len() > 1 || !frame_output.is_empty()))
        || blocks
            .iter()
            .any(|block| block["type"] != "content" || !plain_text(block));
    let mut body = Map::new();
    if status != "completed" {
        body.insert("status".to_owned(), Value::from(status));
    }
    let mut primary = Vec::new();
    if keep_ordered {
        body.insert("items".to_owned(), Value::Array(blocks.to_vec()));
        store_output(
            &mut body,
            raw.filter(|_| separate_output),
            fields.as_ref(),
            Placement::WithBlocks,
        );
        if prefer_blocks {
            primary = independent_text_indices(&blocks, &echoes);
        }
        if primary.is_empty() && !separate_output {
            primary = primary_text_indices(&blocks, echo);
        }
    } else if !frame_output.is_empty() || (use_cache && !output.is_empty() && !prefer_blocks) {
        store_output(&mut body, raw, fields.as_ref(), Placement::Standalone);
        if echo.is_none() && !trim(&text).is_empty() {
            body.insert("items".to_owned(), Value::Array(blocks.into_owned()));
        }
    } else {
        let keep_cached_output = use_cache && !output.is_empty() && echo.is_none();
        store_output(
            &mut body,
            raw.filter(|_| keep_cached_output),
            fields.as_ref(),
            Placement::WithBlocks,
        );
        if !trim(&text).is_empty() {
            let metadata_is_primary = use_cache
                && output.is_empty()
                && fields.is_some()
                && (!prefer_blocks || has_terminal_metadata);
            if body.contains_key("raw") || metadata_is_primary {
                primary = primary_text_indices(&blocks, None);
                body.insert("items".to_owned(), Value::Array(blocks.into_owned()));
            } else {
                body.insert("raw".to_owned(), Value::from(text));
            }
        }
    }
    ToolResultMessage::new(
        timestamp.to_owned(),
        call.tool_call_id.clone(),
        Value::Object(body).into(),
        status != "completed",
        (!primary.is_empty()).then_some(primary),
    )
}
