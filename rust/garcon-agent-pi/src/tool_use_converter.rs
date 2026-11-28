//! Ports `server-agents/pi/src/agents/pi/tool-use-converter.ts`.

use garcon_agents_common::shared::normalize_util::normalize_tool_input;
use garcon_contract::chat_types::ToolUseChatMessage as Row;
use garcon_js::{
    Number,
    json::{self, Opaque},
    parse_int, trim, utf16,
};
use serde_json::{Map, Value};

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn required_string(value: Option<&Value>) -> String {
    // Matches Pi's primitive coercion; malformed calls retain empty canonical inputs.
    // https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/utils/validation.ts#L318-L325
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value
            .as_f64()
            .map(garcon_js::number_to_string)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn number(value: &Value) -> Option<Number> {
    let parsed = match value {
        Value::String(text) => {
            let text = trim(text);
            if text.is_empty() {
                0.0
            } else if let Some((radix, digits)) =
                [(16, ['x', 'X']), (8, ['o', 'O']), (2, ['b', 'B'])]
                    .into_iter()
                    .find_map(|(radix, prefix)| {
                        Some((radix, text.strip_prefix('0')?.strip_prefix(prefix)?))
                    })
            {
                if !digits.chars().all(|digit| digit.is_digit(radix)) {
                    return None;
                }
                parse_int(digits, radix)?
            } else {
                text.parse().ok()?
            }
        }
        _ => json::as_number(value)?,
    };
    parsed.is_finite().then_some(Number(parsed))
}

fn canonicalize(name: &str) -> String {
    trim(name)
        .to_lowercase()
        .chars()
        .filter(|character| {
            !matches!(character, '_' | '-') && !trim(character.encode_utf8(&mut [0; 4])).is_empty()
        })
        .collect()
}

fn parse_edits(value: &Value) -> (Option<String>, Option<String>) {
    match value {
        Value::Array(edits) => {
            let mut edits = edits.iter().filter(|edit| edit.is_object());
            match (edits.next(), edits.next()) {
                (Some(edit), None) => (string(&edit["oldText"]), string(&edit["newText"])),
                _ => (None, None),
            }
        }
        Value::String(text) => {
            json::from_str(text).map_or((None, None), |value| parse_edits(&value))
        }
        _ => (None, None),
    }
}

fn first_edit(input: &Value) -> (Option<String>, Option<String>) {
    if input["oldText"].is_string() || input["newText"].is_string() {
        return (string(&input["oldText"]), string(&input["newText"]));
    }
    parse_edits(&input["edits"])
}

fn mcp_name<'a>(name: &'a str, encoded: &'a str) -> (&'a str, &'a str) {
    let capped = utf16::len(name) == 64
        && name
            .as_bytes()
            .iter()
            .rev()
            .take(9)
            .enumerate()
            .all(|(index, byte)| {
                if index == 8 {
                    *byte == b'_'
                } else {
                    matches!(byte, b'0'..=b'9' | b'a'..=b'f')
                }
            });
    if !capped
        && let Some(separator) = encoded.find("__")
        && separator > 0
        && Some(separator) == encoded.rfind("__")
        && separator + 2 < encoded.len()
    {
        return (&encoded[..separator], &encoded[separator + 2..]);
    }
    // Pi sanitization and the 64-character cap can hide the server/tool boundary.
    // https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/extensions/mcp/tools.ts#L83-L96
    ("", name)
}

pub fn convert_pi_tool_use(
    timestamp: &str,
    tool_id: &str,
    tool_name: &str,
    args: Option<&Opaque>,
) -> Row {
    let timestamp = timestamp.to_owned();
    let tool_id = tool_id.to_owned();
    let empty = Value::Null;
    let input = args
        .map(Opaque::as_value)
        .filter(|value| value.is_object())
        .unwrap_or(&empty);
    let name = if tool_name.is_empty() {
        "Unknown"
    } else {
        tool_name
    };
    let key = canonicalize(name);
    let mcp_input = || {
        Opaque::from_value(Value::Object(
            input.as_object().cloned().unwrap_or_else(Map::new),
        ))
    };

    if let Some(encoded) = tool_name.strip_prefix("mcp__") {
        let (server, tool) = mcp_name(tool_name, encoded);
        return Row::Mcp {
            timestamp,
            tool_id,
            server: server.to_owned(),
            tool: tool.to_owned(),
            input: mcp_input(),
        };
    }

    match key.as_str() {
        "codemode" => Row::Exec {
            timestamp,
            tool_id,
            code: string(&input["code"]).unwrap_or_default(),
            language: "javascript".to_owned(),
        },
        "powershell" => Row::Exec {
            timestamp,
            tool_id,
            code: string(&input["command"]).unwrap_or_default(),
            language: "powershell".to_owned(),
        },
        "toolsearch" => Row::PiToolSearch {
            timestamp,
            tool_id,
            query: string(&input["query"]).unwrap_or_default(),
            limit: number(&input["limit"]),
        },
        "listmcpresources" | "listmcpresourcetemplates" | "readmcpresource" => Row::Mcp {
            timestamp,
            tool_id,
            server: string(&input["server"]).unwrap_or_default(),
            tool: tool_name.to_owned(),
            input: mcp_input(),
        },
        "bash" => Row::Bash {
            timestamp,
            tool_id,
            command: required_string(input.get("command")),
            description: None,
        },
        "read" => Row::Read {
            timestamp,
            tool_id,
            file_path: required_string(input.get("path")),
            offset: number(&input["offset"]),
            limit: number(&input["limit"]),
            end_line: None,
        },
        "ls" => Row::List {
            timestamp,
            tool_id,
            path: string(&input["path"]),
        },
        "write" => Row::Write {
            timestamp,
            tool_id,
            file_path: required_string(input.get("path")),
            content: string(&input["content"]),
        },
        "edit" => {
            let (old_string, new_string) = first_edit(input);
            Row::Edit {
                timestamp,
                tool_id,
                file_path: Some(required_string(input.get("path"))),
                old_string,
                new_string,
                changes: None,
            }
        }
        "grep" => Row::Grep {
            timestamp,
            tool_id,
            pattern: string(&input["pattern"]),
            path: string(&input["path"]),
        },
        "find" => Row::Glob {
            timestamp,
            tool_id,
            pattern: string(&input["pattern"]),
            path: string(&input["path"]),
        },
        _ => Row::Unknown {
            timestamp,
            tool_id,
            raw_name: name.to_owned(),
            input: normalize_tool_input(args),
        },
    }
}
