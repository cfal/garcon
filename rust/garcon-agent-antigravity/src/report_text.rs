//! Ports `server-agents/antigravity/src/agents/antigravity/report-text.ts`.

use std::rc::Rc;

use garcon_contract::tool_result_content::tool_result_text_part;
use garcon_js::{trim, trim_end, trim_start, utf16};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::tool_call_snapshot::TrackedCall;

pub fn raw_output_text(raw: Option<&Value>) -> &str {
    raw.and_then(|raw| {
        raw.as_str()
            .or_else(|| raw.get("output").and_then(Value::as_str))
    })
    .unwrap_or_default()
}

pub fn block_text(block: &Value) -> &str {
    tool_result_text_part(block).map_or("", |part| part.text)
}

pub fn joined_report_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .map(block_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TextEcho {
    pub first: usize,
    pub last: usize,
}

fn overlapping_starts(text: &[u16], pattern: &[u16]) -> impl Iterator<Item = usize> {
    let mut borders = vec![0; pattern.len()];
    let mut matched = 0;
    for index in 1..pattern.len() {
        while matched != 0 && pattern[index] != pattern[matched] {
            matched = borders[matched - 1];
        }
        if pattern[index] == pattern[matched] {
            matched += 1;
        }
        borders[index] = matched;
    }
    let mut matched = 0;
    text.iter()
        .enumerate()
        .filter_map(move |(index, character)| {
            while matched != 0 && *character != pattern[matched] {
                matched = borders[matched - 1];
            }
            if *character == pattern[matched] {
                matched += 1;
            }
            if matched == pattern.len() {
                let start = index + 1 - matched;
                matched = borders[matched - 1];
                Some(start)
            } else {
                None
            }
        })
}

pub fn text_echoes(blocks: &[Value], output: &str) -> Vec<TextEcho> {
    if output.is_empty() {
        return Vec::new();
    }
    let mut starts = IndexMap::new();
    let mut ends = IndexMap::new();
    let mut offset = 0;
    let len = utf16::len(output);
    for (index, text) in blocks.iter().map(block_text).enumerate() {
        if text.is_empty() {
            continue;
        }
        let start = utf16::len(text) - utf16::len(trim_start(text));
        let end = utf16::len(trim_end(text));
        if end != 0 {
            starts.insert(offset + start, index);
            ends.insert(offset + end, index);
        }
        offset += utf16::len(text) + 1;
    }
    let candidates: Vec<_> = starts
        .keys()
        .copied()
        .filter(|start| ends.contains_key(&(start + len)))
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    let text: Vec<_> = joined_report_text(blocks).encode_utf16().collect();
    let pattern: Vec<_> = output.encode_utf16().collect();
    let echo = |start| {
        Some(TextEcho {
            first: *starts.get(&start)?,
            last: *ends.get(&(start + len))?,
        })
    };
    if candidates
        .windows(2)
        .any(|window| window[1] < window[0] + len)
    {
        overlapping_starts(&text, &pattern)
            .filter_map(echo)
            .collect()
    } else {
        candidates
            .into_iter()
            .filter(|&start| {
                text.get(start..)
                    .is_some_and(|text| text.starts_with(&pattern))
            })
            .filter_map(echo)
            .collect()
    }
}

pub fn unique_echo(matches: &[TextEcho]) -> Option<TextEcho> {
    match matches {
        [echo] => Some(*echo),
        _ => None,
    }
}

pub fn independent_text_indices(blocks: &[Value], echoes: &[TextEcho]) -> Vec<usize> {
    let mut run = 0;
    blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            while run < echoes.len() && echoes[run].last < index {
                run += 1;
            }
            if run < echoes.len() && echoes[run].first <= index {
                return None;
            }
            (!trim(block_text(block)).is_empty()).then_some(index)
        })
        .collect()
}

fn narrative(blocks: &[Value], echoes: &[TextEcho]) -> String {
    independent_text_indices(blocks, echoes)
        .iter()
        .map(|&i| trim(block_text(&blocks[i])))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn prefers_report_content(
    previous: Option<&TrackedCall>,
    raw: Option<&Value>,
    blocks: Option<&Rc<Vec<Value>>>,
) -> bool {
    let output = trim(raw_output_text(raw));
    if !output.is_empty() && output != trim(raw_output_text(previous.and_then(TrackedCall::output)))
    {
        return false;
    }
    let was_newer = previous.is_some_and(|previous| previous.report_content_is_newer);
    let Some(blocks) = blocks else {
        return was_newer;
    };
    if previous
        .and_then(|previous| previous.content.as_ref())
        .is_some_and(|before| Rc::ptr_eq(before, blocks))
    {
        return was_newer;
    }
    let before = previous.map_or(&[][..], TrackedCall::blocks);
    if narrative(before, &[]) == narrative(blocks, &[]) {
        return was_newer;
    }
    let old_echoes = text_echoes(before, output);
    let new_echoes = text_echoes(blocks, output);
    let latest = narrative(blocks, &new_echoes);
    let prior = narrative(before, &old_echoes);
    if latest.is_empty()
        || latest == prior
        || (!new_echoes.is_empty() && old_echoes.is_empty() && prior.is_empty())
    {
        return was_newer;
    }
    true
}

pub fn primary_text_indices(blocks: &[Value], matched: Option<TextEcho>) -> Vec<usize> {
    blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            (!trim(block_text(block)).is_empty()
                && matched.is_none_or(|matched| (matched.first..=matched.last).contains(&index)))
            .then_some(index)
        })
        .collect()
}
