//! Ports `common/garcon-command-envelope.ts`.

use std::borrow::Cow;
use std::collections::HashMap;

use garcon_js::trim;
use indexmap::IndexMap;
use serde::Serialize;

use crate::garcon_command_text::normalize_garcon_command_body;
use crate::ticket_commands::TICKET_ACTIONS;

pub const GARCON_COMMAND_ENVELOPE_MAX_BYTES: usize = 64 * 1024;
pub const GARCON_ELEMENT_PREFIX: &str = "<garcon-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct GarconEnvelopeCommand(&'static str);

impl GarconEnvelopeCommand {
    pub const fn as_str(self) -> &'static str {
        self.0
    }

    fn is_prompt(self) -> bool {
        matches!(self.0, "start-agent" | "resume-agent")
    }
}

pub const GARCON_ENVELOPE_COMMANDS: &[GarconEnvelopeCommand] = &[
    GarconEnvelopeCommand("send-message"),
    GarconEnvelopeCommand("start-agent"),
    GarconEnvelopeCommand("resume-agent"),
    GarconEnvelopeCommand("stop-agent"),
    GarconEnvelopeCommand("schedule"),
    GarconEnvelopeCommand("ticket-create"),
    GarconEnvelopeCommand("ticket-update"),
    GarconEnvelopeCommand("ticket-claim"),
    GarconEnvelopeCommand("ticket-release"),
    GarconEnvelopeCommand("ticket-reopen"),
    GarconEnvelopeCommand("ticket-close"),
    GarconEnvelopeCommand("ticket-comment"),
    GarconEnvelopeCommand("ticket-comment-edit"),
    GarconEnvelopeCommand("ticket-comment-delete"),
    GarconEnvelopeCommand("ticket-link"),
    GarconEnvelopeCommand("ticket-unlink"),
    GarconEnvelopeCommand("ticket-list"),
    GarconEnvelopeCommand("ticket-read"),
    GarconEnvelopeCommand("ticket-history"),
];

const _: () = assert!(GARCON_ENVELOPE_COMMANDS.len() == 5 + TICKET_ACTIONS.len());

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GarconEnvelopeSpan {
    pub command: GarconEnvelopeCommand,
    pub start: f64,
    pub end: Option<usize>,
}

#[derive(Debug)]
pub struct GarconEnvelopeScanner {
    content: Vec<u16>,
    suffixes: HashMap<GarconEnvelopeCommand, HashMap<usize, bool>>,
    suffix_end: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconEnvelopeSpans {
    pub spans: Vec<GarconEnvelopeSpan>,
    pub open_fence: bool,
}

impl GarconEnvelopeScanner {
    pub fn new(content: &str) -> Self {
        Self {
            content: content.encode_utf16().collect(),
            suffixes: HashMap::new(),
            suffix_end: None,
        }
    }

    pub fn content(&self) -> String {
        String::from_utf16_lossy(&self.content)
    }

    pub fn span_at(&mut self, start: f64, end: f64) -> Option<GarconEnvelopeSpan> {
        let boundary = scan_boundary(&self.content, start, limit(&self.content, end))?;
        let mut span = boundary.span;
        if let Some(span_end) = span.end
            && span.command.is_prompt()
        {
            if self.suffix_end != Some(end) {
                self.suffixes.clear();
                self.suffix_end = Some(end);
            }
            let cache = self.suffixes.entry(span.command).or_default();
            if has_unmatched_prompt_closer(&self.content, span.command, span_end, end, cache) {
                span.end = None;
            }
        }
        Some(span)
    }

    pub fn spans(
        &mut self,
        start: usize,
        end: usize,
        mut is_removed_envelope: impl FnMut(&GarconEnvelopeSpan) -> bool,
    ) -> GarconEnvelopeSpans {
        let end = end.min(self.content.len());
        let mut spans = Vec::new();
        let mut cursor = start;
        let mut opaque_through = start;
        let mut fence: Option<(u16, usize)> = None;
        while cursor < end {
            let line_end = position(&self.content, b'\n', cursor)
                .unwrap_or(end)
                .min(end);
            if let Some(delimiter) = markdown_fence(&self.content[cursor..line_end]) {
                if let Some(opener) = fence {
                    if fence_closes(delimiter, opener) {
                        fence = None;
                    }
                } else {
                    fence = Some((delimiter.0, delimiter.1));
                }
            } else if fence.is_none()
                && cursor >= opaque_through
                && let Some(span) = self.span_at(cursor as f64, end as f64)
            {
                let Some(span_end) = span.end else {
                    spans.push(span);
                    return GarconEnvelopeSpans {
                        spans,
                        open_fence: false,
                    };
                };
                let removed = is_removed_envelope(&span);
                spans.push(span);
                if !removed {
                    opaque_through = span_end;
                    cursor = line_end + 1;
                    continue;
                }
                if span_end == end {
                    break;
                }
                cursor =
                    position(&self.content, b'\n', span_end).map_or(end, |newline| newline + 1);
                continue;
            }
            cursor = line_end + 1;
        }
        GarconEnvelopeSpans {
            spans,
            open_fence: fence.is_some(),
        }
    }
}

pub fn garcon_envelope_command_at(content: &str, start: f64) -> Option<GarconEnvelopeCommand> {
    let units: Vec<_> = content.encode_utf16().collect();
    command_at(&units, start)
}

pub fn garcon_envelope_span_at(content: &str, start: f64, end: f64) -> Option<GarconEnvelopeSpan> {
    GarconEnvelopeScanner::new(content).span_at(start, end)
}

fn command_at(content: &[u16], start: f64) -> Option<GarconEnvelopeCommand> {
    let pos = start as usize;
    if !ascii_starts_at(content, pos, GARCON_ELEMENT_PREFIX) {
        return None;
    }
    let rest = pos + GARCON_ELEMENT_PREFIX.len();
    GARCON_ENVELOPE_COMMANDS.iter().copied().find(|command| {
        ascii_starts_at(content, rest, command.0)
            && unit_at_number(
                content,
                start + (GARCON_ELEMENT_PREFIX.len() + command.0.len()) as f64,
            )
            .is_none_or(|unit| {
                unit_space(unit) || unit == u16::from(b'/') || unit == u16::from(b'>')
            })
    })
}

fn unit_at_number(content: &[u16], index: f64) -> Option<u16> {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 {
        return None;
    }
    content.get(index as usize).copied()
}

fn ascii_starts_at(content: &[u16], index: usize, pattern: &str) -> bool {
    content.get(index..).is_some_and(|units| {
        units.len() >= pattern.len()
            && units
                .iter()
                .zip(pattern.bytes())
                .all(|(&a, b)| a == u16::from(b))
    })
}

fn position(content: &[u16], byte: u8, start: usize) -> Option<usize> {
    content
        .get(start..)?
        .iter()
        .position(|&unit| unit == u16::from(byte))
        .map(|offset| start + offset)
}

fn find_ascii(content: &[u16], pattern: &str, start: usize) -> Option<usize> {
    let mut from = start;
    let first = pattern.as_bytes()[0];
    while let Some(pos) = position(content, first, from) {
        if ascii_starts_at(content, pos, pattern) {
            return Some(pos);
        }
        from = pos + 1;
    }
    None
}

fn unit_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_space)
}

fn limit(content: &[u16], end: f64) -> f64 {
    if end.is_nan() {
        0.0
    } else {
        end.clamp(0.0, content.len() as f64)
    }
}

#[derive(Debug)]
struct Boundary {
    span: GarconEnvelopeSpan,
    complete_framing: bool,
}

fn scan_boundary(content: &[u16], start: f64, end: f64) -> Option<Boundary> {
    let command = command_at(content, start)?;
    let mut span = GarconEnvelopeSpan {
        command,
        start,
        end: None,
    };
    let end_ceil = end.ceil() as usize;
    let end_floor = end as usize;
    let opener = opener_from_number(content, start, end_ceil);
    let Some(opener) = opener else {
        return Some(Boundary {
            span,
            complete_framing: false,
        });
    };
    if opener.self_closing {
        span.end = Some(opener.end);
        return Some(Boundary {
            span,
            complete_framing: true,
        });
    }
    let literal_prompt = command.is_prompt();
    let mut nesting = vec![command];
    let mut complete_framing = opener.complete;
    let mut cursor = opener.end;
    while let Some(next) = position(content, b'<', cursor).filter(|&next| next < end_ceil) {
        if let Some(opaque) = opaque_markup_end(content, next, end_floor) {
            let Some(opaque_end) = opaque else { break };
            cursor = opaque_end;
            continue;
        }
        if !literal_prompt && ascii_starts_at(content, next, "<!") {
            break;
        }
        if let Some(close_end) =
            closing_end(content, next, *nesting.last().expect("nonempty nesting"))
            && close_end <= end_floor
        {
            nesting.pop();
            if nesting.is_empty() {
                span.end = Some(close_end);
                break;
            }
            cursor = close_end;
            continue;
        }
        if ascii_starts_at(content, next, "</garcon-")
            && GARCON_ENVELOPE_COMMANDS
                .iter()
                .any(|&command| closing_end(content, next, command).is_some())
        {
            if literal_prompt {
                break;
            }
            // Native bodies keep their boundaries without shielding a later prompt closer.
            complete_framing = false;
        }
        let nested = command_at(content, next as f64);
        if literal_prompt && nested.is_none() {
            cursor = next + 1;
            continue;
        }
        let Some(opener) = scan_opener(content, next + 1, end_ceil) else {
            break;
        };
        if let Some(nested) = nested {
            complete_framing &= opener.complete;
            if !opener.self_closing {
                nesting.push(nested);
            }
        }
        cursor = opener.end;
    }
    Some(Boundary {
        span,
        complete_framing,
    })
}

fn opener_from_number(content: &[u16], start: f64, end: usize) -> Option<GarconEnvelopeOpener> {
    if !start.is_finite() || start.fract() != 0.0 {
        return None;
    }
    scan_opener(content, (start + 1.0) as usize, end)
}

fn closing_end(content: &[u16], start: usize, command: GarconEnvelopeCommand) -> Option<usize> {
    if ascii_starts_at(content, start, "</garcon-")
        && ascii_starts_at(content, start + 9, command.0)
        && content.get(start + 9 + command.0.len()) == Some(&u16::from(b'>'))
    {
        Some(start + 10 + command.0.len())
    } else {
        None
    }
}

fn opaque_markup_end(content: &[u16], start: usize, end: usize) -> Option<Option<usize>> {
    for (open, close) in [("<!--", "-->"), ("<![CDATA[", "]]>"), ("<?", "?>")] {
        if ascii_starts_at(content, start, open) {
            return Some(
                find_ascii(content, close, start + open.len())
                    .map(|p| p + close.len())
                    .filter(|&p| p <= end),
            );
        }
    }
    None
}

fn has_unmatched_prompt_closer(
    content: &[u16],
    command: GarconEnvelopeCommand,
    start: usize,
    end: f64,
    cache: &mut HashMap<usize, bool>,
) -> bool {
    let end = limit(content, end);
    let end_ceil = end.ceil() as usize;
    let end_floor = end as usize;
    let closer = format!("</garcon-{}>", command.0);
    let mut visited = Vec::new();
    let mut cursor = start;
    let mut closer_at = None;
    let mut next = None;
    let mut line_end = None;
    let unmatched = loop {
        if cursor >= end_ceil {
            break false;
        }
        if let Some(&cached) = cache.get(&cursor) {
            break cached;
        }
        visited.push(cursor);
        if closer_at.is_none_or(|at| at < cursor) {
            closer_at = find_ascii(content, &closer, cursor);
        }
        if closer_at.is_none_or(|at| at + closer.len() > end_floor) {
            break false;
        }
        if line_end.is_none_or(|at| at < cursor) {
            line_end = Some(
                position(content, b'\n', cursor)
                    .unwrap_or(end_ceil)
                    .min(end_ceil),
            );
        }
        if (cursor == 0 || content.get(cursor - 1) == Some(&u16::from(b'\n')))
            && let Some(fence) = markdown_fence_end(content, cursor, end_ceil)
        {
            let Some(fence_end) = fence else { break true };
            cursor = fence_end;
            continue;
        }
        if next.is_none_or(|at| at < cursor) {
            next = position(content, b'<', cursor);
        }
        let Some(at) = next.filter(|&next| next < end_ceil) else {
            break false;
        };
        if let Some(end_of_line) = line_end.filter(|&line| at >= line) {
            cursor = end_of_line + 1;
            continue;
        }
        if let Some(opaque) = opaque_markup_end(content, at, end_floor) {
            let Some(opaque_end) = opaque else { break true };
            cursor = opaque_end;
            continue;
        }
        if ascii_starts_at(content, at, &closer) {
            break true;
        }
        if let Some(sibling) = scan_boundary(content, at as f64, end) {
            if let Some(sibling_end) = sibling.span.end.filter(|_| sibling.complete_framing) {
                cursor = sibling_end;
                continue;
            }
            break true;
        }
        if !resembles_native_markup(&content[at..end_ceil]) {
            cursor = at + 1;
            continue;
        }
        let Some(markup) = scan_opener(content, at + 1, end_ceil) else {
            break true;
        };
        cursor = markup.end;
    };
    cache.extend(visited.into_iter().map(|pos| (pos, unmatched)));
    unmatched
}

fn resembles_native_markup(content: &[u16]) -> bool {
    fn name_char(unit: u16) -> bool {
        u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric() || b"_:-.".contains(&b))
    }
    let name = content.get(1..).unwrap_or_default();
    let name = name.strip_prefix(&[u16::from(b'/')]).unwrap_or(name);
    let Some((&first, tail)) = name.split_first() else {
        return false;
    };
    if !u8::try_from(first).is_ok_and(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    let after_name = &tail[tail.iter().take_while(|&&unit| name_char(unit)).count()..];
    let after_space = &after_name[after_name
        .iter()
        .take_while(|&&unit| unit_space(unit))
        .count()..];
    if ascii_starts_at(after_space, 0, ">") || ascii_starts_at(after_space, 0, "/>") {
        return true;
    }
    if after_name.len() == after_space.len() {
        return false;
    }
    let Some((&first, tail)) = after_space.split_first() else {
        return false;
    };
    if !u8::try_from(first).is_ok_and(|b| b.is_ascii_alphabetic() || b"_:".contains(&b)) {
        return false;
    }
    let after_attribute = &tail[tail.iter().take_while(|&&unit| name_char(unit)).count()..];
    after_attribute.iter().find(|&&unit| !unit_space(unit)) == Some(&u16::from(b'='))
}

fn markdown_fence_end(content: &[u16], start: usize, end: usize) -> Option<Option<usize>> {
    let line_end = position(content, b'\n', start).unwrap_or(end).min(end);
    let (character, length, _) = markdown_fence(&content[start..line_end])?;
    let mut cursor = line_end + 1;
    while cursor < end {
        let next_end = position(content, b'\n', cursor).unwrap_or(end).min(end);
        if markdown_fence(&content[cursor..next_end])
            .is_some_and(|candidate| fence_closes(candidate, (character, length)))
        {
            return Some(Some((next_end + 1).min(end)));
        }
        cursor = next_end + 1;
    }
    Some(None)
}

fn markdown_fence(line: &[u16]) -> Option<(u16, usize, &[u16])> {
    let indent = line
        .iter()
        .take_while(|&&unit| unit == u16::from(b' '))
        .count();
    if indent > 3 {
        return None;
    }
    let suffix = line.get(indent..)?;
    let char = *suffix.first()?;
    if char != u16::from(b'`') && char != u16::from(b'~') {
        return None;
    }
    let length = suffix.iter().take_while(|&&unit| unit == char).count();
    let tail = &suffix[length..];
    let tail = tail.strip_suffix(&[u16::from(b'\r')]).unwrap_or(tail);
    (length >= 3 && !tail.contains(&u16::from(b'\r'))).then_some((char, length, tail))
}

fn fence_closes(candidate: (u16, usize, &[u16]), opener: (u16, usize)) -> bool {
    candidate.0 == opener.0
        && candidate.1 >= opener.1
        && candidate.2.iter().copied().all(unit_space)
}

pub fn garcon_envelope_opener_end(content: &str, start: f64) -> isize {
    let units: Vec<_> = content.encode_utf16().collect();
    opener_from_number(&units, start, units.len())
        .filter(|opener| opener.complete)
        .map_or(-1, |opener| opener.end as isize)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconCommandEnvelope {
    pub attributes: IndexMap<String, String>,
    pub body: String,
    pub self_closing: bool,
}

pub(crate) fn invalid_text_controls(value: &str) -> bool {
    value
        .bytes()
        .any(|byte| matches!(byte, 0..=8 | 11..=12 | 14..=31))
}

pub fn decode_garcon_xml_text(value: &str) -> Option<Cow<'_, str>> {
    if value.contains('<') || invalid_text_controls(value) {
        return None;
    }
    if !value.contains('&') {
        return Some(Cow::Borrowed(value));
    }
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some((before, entity)) = rest.split_once('&') {
        result.push_str(before);
        let (name, after) = entity.split_once(';')?;
        result.push(match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => return None,
        });
        rest = after;
    }
    result.push_str(rest);
    Some(Cow::Owned(result))
}

pub fn escape_garcon_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[derive(Debug)]
struct GarconEnvelopeFrame<'a> {
    attributes: IndexMap<String, String>,
    body: &'a str,
    self_closing: bool,
}

#[derive(Debug, Clone, Copy)]
struct GarconEnvelopeOpener {
    end: usize,
    complete: bool,
    self_closing: bool,
}

fn scan_opener<Unit: Copy + PartialEq + From<u8>>(
    content: &[Unit],
    start: usize,
    end: usize,
) -> Option<GarconEnvelopeOpener> {
    let mut quote = None;
    for (index, &unit) in content.iter().enumerate().take(end).skip(start) {
        if unit == b'<'.into() {
            return quote.is_none().then_some(GarconEnvelopeOpener {
                end: index,
                complete: false,
                self_closing: false,
            });
        }
        if quote == Some(unit) {
            quote = None;
        } else if quote.is_none() && (unit == b'"'.into() || unit == b'\''.into()) {
            quote = Some(unit);
        }
        if unit == b'>'.into() && quote.is_none() {
            return Some(GarconEnvelopeOpener {
                end: index + 1,
                complete: true,
                self_closing: index > 0 && content[index - 1] == b'/'.into(),
            });
        }
    }
    None
}

fn parse_frame<'a>(
    content: &'a str,
    name: &str,
    allowed_attributes: &[impl AsRef<str>],
) -> Option<GarconEnvelopeFrame<'a>> {
    if !content.strip_prefix('<')?.starts_with(name)
        || content.len() > GARCON_COMMAND_ENVELOPE_MAX_BYTES
    {
        return None;
    }
    let open =
        scan_opener(content.as_bytes(), 1, content.len()).filter(|opener| opener.complete)?;
    let opener = content
        .get(name.len() + 1..open.end - 1)
        .unwrap_or_default();
    let self_closing = opener.ends_with('/');
    let mut rest = opener.strip_suffix('/').unwrap_or(opener);
    let mut attributes = IndexMap::new();
    while !trim(rest).is_empty() {
        let token = trim_start(rest);
        if token.len() == rest.len() {
            return None;
        }
        let (key, quoted) = token.split_once("=\"")?;
        let (first, tail) = key.as_bytes().split_first()?;
        if !first.is_ascii_lowercase()
            || !tail.iter().all(|b| b.is_ascii_lowercase() || *b == b'-')
            || !allowed_attributes.iter().any(|s| s.as_ref() == key)
            || attributes.contains_key(key)
        {
            return None;
        }
        let (raw, after) = quoted.split_once('"')?;
        let value = decode_garcon_xml_text(raw)?;
        if trim(&value).is_empty() {
            return None;
        }
        attributes.insert(key.to_owned(), value.into_owned());
        rest = after;
    }
    let body = if self_closing {
        if open.end != content.len() {
            return None;
        }
        ""
    } else {
        let close = format!("</{name}>");
        content.get(open.end..)?.strip_suffix(&close)?
    };
    Some(GarconEnvelopeFrame {
        attributes,
        body,
        self_closing,
    })
}

pub(crate) fn is_space(ch: char) -> bool {
    let mut bytes = [0; 4];
    trim(ch.encode_utf8(&mut bytes)).is_empty()
}

pub(crate) fn positive_decimal(text: &str) -> Option<f64> {
    if text.starts_with('0') || text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

pub(crate) fn escape_attribute(value: &str) -> String {
    escape_garcon_xml_text(value).replace('"', "&quot;")
}

fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

pub fn parse_garcon_xml_envelope(
    content: &str,
    name: &str,
    allowed_attributes: &[impl AsRef<str>],
) -> Option<GarconCommandEnvelope> {
    let frame = parse_frame(content, name, allowed_attributes)?;
    Some(GarconCommandEnvelope {
        attributes: frame.attributes,
        body: decode_garcon_xml_text(frame.body)?.into_owned(),
        self_closing: frame.self_closing,
    })
}

pub fn parse_garcon_command_envelope(
    content: &str,
    name: &str,
    allowed_attributes: &[impl AsRef<str>],
) -> Option<GarconCommandEnvelope> {
    let mut frame = parse_garcon_xml_envelope(content, name, allowed_attributes)?;
    frame.body = normalize_garcon_command_body(&frame.body).to_owned();
    Some(frame)
}

pub fn parse_garcon_prompt_envelope(
    content: &str,
    name: &str,
    allowed_attributes: &[impl AsRef<str>],
) -> Option<GarconCommandEnvelope> {
    let frame = parse_frame(content, name, allowed_attributes)?;
    if invalid_text_controls(frame.body) {
        return None;
    }
    let units: Vec<_> = content.encode_utf16().collect();
    let boundary = scan_boundary(&units, 0.0, units.len() as f64)?;
    if !boundary.complete_framing || boundary.span.end != Some(units.len()) {
        return None;
    }
    Some(GarconCommandEnvelope {
        attributes: frame.attributes,
        body: normalize_garcon_command_body(frame.body).to_owned(),
        self_closing: frame.self_closing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_spans_in_utf16_even_with_unpaired_code_units() {
        let cmd = "<garcon-schedule />";
        let mut units = vec![0xd800, 0xd83e, 0xddea];
        units.extend(cmd.encode_utf16());
        assert!(command_at(&units, 2.0).is_none());
        let boundary = scan_boundary(&units, 3.0, units.len() as f64).unwrap();
        assert_eq!(boundary.span.command.as_str(), "schedule");
        assert_eq!(boundary.span.end, Some(3 + cmd.len()));
    }

    #[test]
    fn suffix_memoization_is_independent_of_lookup_order_after_sheltered_closers() {
        for family in ["start-agent", "resume-agent"] {
            let command = format!("<garcon-{family}>Synthetic.</garcon-{family}>");
            for shelter in [command.clone(), format!("```xml\n{command}\n```")] {
                let content = format!("{command}\n{shelter}\n<garcon-schedule\n");
                let end = content.len() as f64;
                let second_start = (command.len() + 1) as f64;
                let mut scanner = GarconEnvelopeScanner::new(&content);
                let first = scanner.span_at(0.0, end).unwrap();
                assert_eq!(first.end, Some(command.len()));
                scanner.span_at(second_start, end);
                assert_eq!(scanner.span_at(0.0, end), Some(first.clone()));
                let mut reverse = GarconEnvelopeScanner::new(&content);
                reverse.span_at(second_start, end);
                assert_eq!(reverse.span_at(0.0, end), Some(first));
            }
        }
    }

    #[test]
    fn retained_native_bodies_contribute_fences_without_exposing_nested_commands() {
        let content = "<garcon-start-agent>\n```xml\n<garcon-schedule />\n</garcon-start-agent>\n<garcon-ticket-list />";
        let mut scanner = GarconEnvelopeScanner::new(content);
        let retained = scanner.spans(0, content.len(), |_| false);
        assert!(retained.open_fence);
        assert_eq!(retained.spans.len(), 1);
        let removed = scanner.spans(0, content.len(), |_| true);
        assert!(!removed.open_fence);
        assert_eq!(
            removed
                .spans
                .iter()
                .map(|span| span.command.as_str())
                .collect::<Vec<_>>(),
            ["start-agent", "ticket-list"],
        );
    }
}
