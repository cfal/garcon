//! Ports `server-agents/opencode/src/agents/opencode/tool-use-converter.ts`.

use std::{collections::HashSet, sync::LazyLock};

use garcon_contract::chat_message_coercion::{
    AskUserQuestionOption, AskUserQuestionPrompt, as_allowed_prompts, as_optional_changes,
    as_record,
};
use garcon_contract::chat_plan::{PlanStep, coerce_todo_items};
use garcon_contract::chat_types::ToolUseChatMessage as Message;
use garcon_js::{Number, OptionalNullable, json::Opaque};
use serde_json::{Map, Value};

use crate::js::{prop, string_to_number, strip_name_separators};

// The built-in tool inventory shipped by OpenCode 1.18.34.
// https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/tool/registry.ts#L231-L249
pub const OPENCODE_BUILTIN_TOOL_IDS: &[&str] = &[
    "invalid",
    "question",
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "task",
    "webfetch",
    "todowrite",
    "websearch",
    "skill",
    "apply_patch",
    "execute",
    "lsp",
    "plan_exit",
];
static OPENCODE_BUILTIN_TOOL_KEYS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    OPENCODE_BUILTIN_TOOL_IDS
        .iter()
        .map(|id| strip_name_separators(id))
        .collect()
});

fn as_input(value: &Value) -> Opaque {
    let input = match value {
        Value::Object(_) => value.clone(),
        Value::String(raw) if !raw.is_empty() => match garcon_js::json::parse(raw) {
            Ok(value @ Value::Object(_)) => value,
            _ => Value::Object(Map::from_iter([("raw".to_owned(), value.clone())])),
        },
        _ => Value::Object(Map::new()),
    };
    Opaque::from_value(input)
}

fn as_number(value: &Value) -> Option<Number> {
    value
        .as_str()
        .map(string_to_number)
        .or_else(|| garcon_js::json::as_number(value))
        .filter(|value| value.is_finite())
        .map(Number)
}

pub fn convert_open_code_question_tool_use(
    ts: &str,
    tool_id: &str,
    value: &Value,
) -> Option<Message> {
    let mut questions = Vec::new();
    for (question_index, question) in value.as_array()?.iter().enumerate() {
        let prompt = prop(question, "question")
            .as_str()
            .filter(|prompt| !prompt.is_empty())?;
        let id = format!("question-{}", question_index + 1);
        let options = prop(question, "options")
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, option)| {
                let label = prop(option, "label")
                    .as_str()
                    .filter(|label| !label.is_empty())?;
                Some(AskUserQuestionOption {
                    id: format!("{id}-option-{}", index + 1),
                    label: label.to_owned(),
                    description: prop(option, "description").as_str().map(str::to_owned),
                    preview: None,
                })
            })
            .collect();
        questions.push(AskUserQuestionPrompt {
            id,
            prompt: prompt.to_owned(),
            options,
            header: prop(question, "header")
                .as_str()
                .filter(|header| !header.is_empty())
                .map(str::to_owned),
            allow_multiple: Some(prop(question, "multiple").as_bool().unwrap_or(false)),
            allow_free_text: None,
            allow_notes: None,
            is_secret: None,
        });
    }
    (!questions.is_empty()).then(|| Message::AskUserQuestion {
        timestamp: ts.to_owned(),
        tool_id: tool_id.to_owned(),
        title: None,
        questions,
    })
}

pub fn convert_open_code_tool_use(ts: &str, part: &Value) -> Message {
    let tool = prop(part, "tool").as_str();
    let raw_name = tool.unwrap_or("Unknown");
    let tool_id = prop(part, "callID")
        .as_str()
        .or_else(|| prop(part, "id").as_str())
        .unwrap_or_default();
    let raw_input = prop(prop(part, "state"), "input");
    let key = strip_name_separators(raw_name);
    if let Some(message) = known_tool(ts, tool_id, &key, as_record(raw_input)) {
        return message;
    }

    let input = as_input(raw_input);
    if tool.is_none()
        || (!matches!(key.as_str(), "invalid" | "skill" | "lsp")
            && OPENCODE_BUILTIN_TOOL_KEYS.contains(&key))
    {
        Message::Unknown {
            timestamp: ts.to_owned(),
            tool_id: tool_id.to_owned(),
            raw_name: raw_name.to_owned(),
            input,
        }
    } else {
        Message::External {
            timestamp: ts.to_owned(),
            tool_id: tool_id.to_owned(),
            name: raw_name.to_owned(),
            input,
            namespace: OptionalNullable::some("opencode".to_owned()),
        }
    }
}

fn known_tool(ts: &str, tool_id: &str, key: &str, input: &Map<String, Value>) -> Option<Message> {
    let timestamp = ts.to_owned();
    let prop = |key| prop(input, key);
    let coalesce = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| input.get(*key).filter(|value| !value.is_null()))
            .unwrap_or(&Value::Null)
    };
    let string = |key| prop(key).as_str().map(str::to_owned);
    let first_string = |keys: &[&str]| coalesce(keys).as_str().map(str::to_owned);
    let tool_id = tool_id.to_owned();
    Some(match key {
        "bash" | "shellcommand" | "execcommand" => Message::Bash {
            timestamp,
            tool_id,
            command: string("command")?,
            description: string("description"),
        },
        "read" => Message::Read {
            timestamp,
            tool_id,
            file_path: first_string(&["file_path", "filePath", "path"])?,
            offset: as_number(coalesce(&["offset", "start_line", "startLine"])),
            limit: as_number(coalesce(&["limit", "num_lines", "numLines"])),
            end_line: as_number(coalesce(&["end_line", "endLine"])),
        },
        "edit" => Message::Edit {
            timestamp,
            tool_id,
            file_path: first_string(&["file_path", "filePath"]),
            old_string: first_string(&["old_string", "oldString"]),
            new_string: first_string(&["new_string", "newString"]),
            changes: as_optional_changes(prop("changes")),
        },
        "write" => Message::Write {
            timestamp,
            tool_id,
            file_path: first_string(&["file_path", "filePath"])?,
            content: string("content"),
        },
        "applypatch" => Message::ApplyPatch {
            timestamp,
            tool_id,
            file_path: None,
            old_string: None,
            new_string: None,
            patch: Some(first_string(&["patchText", "patch_text", "patch"])?),
        },
        "grep" => Message::Grep {
            timestamp,
            tool_id,
            pattern: string("pattern"),
            path: string("path"),
        },
        "glob" => Message::Glob {
            timestamp,
            tool_id,
            pattern: string("pattern"),
            path: string("path"),
        },
        "websearch" => Message::WebSearch {
            timestamp,
            tool_id,
            query: string("query")?,
        },
        "webfetch" => Message::WebFetch {
            timestamp,
            tool_id,
            url: string("url")?,
            prompt: string("prompt"),
        },
        "todowrite" => Message::TodoWrite {
            timestamp,
            tool_id,
            todos: coerce_todo_items(coalesce(&["todos", "items"])),
        },
        "todoread" => Message::TodoRead { timestamp, tool_id },
        "task" => Message::Task {
            timestamp,
            tool_id,
            subagent_type: first_string(&["subagent_type", "subagentType"]),
            description: string("description"),
            prompt: string("prompt"),
            model: string("model"),
            resume: first_string(&["task_id", "taskId", "resume"]),
        },
        "updateplan" => Message::UpdatePlan {
            timestamp,
            tool_id,
            todos: coerce_todo_items(coalesce(&["items", "todos"])).map(|items| {
                items
                    .into_iter()
                    .map(|item| PlanStep {
                        content: item.content,
                        status: item.status.into(),
                    })
                    .collect()
            }),
        },
        "writestdin" => Message::WriteStdin {
            timestamp,
            tool_id,
            input: Opaque::from_value(Value::Object(input.clone())),
        },
        "enterplanmode" | "planenter" => Message::EnterPlanMode { timestamp, tool_id },
        "exitplanmode" | "exitplan" | "planexit" => Message::ExitPlanMode {
            timestamp,
            tool_id,
            plan: string("plan").unwrap_or_default(),
            allowed_prompts: as_allowed_prompts(prop("allowedPrompts")),
        },
        "question" => {
            return convert_open_code_question_tool_use(&timestamp, &tool_id, prop("questions"));
        }
        "execute" => Message::Exec {
            timestamp,
            tool_id,
            code: string("code")?,
            language: "javascript".to_owned(),
        },
        _ => return None,
    })
}
