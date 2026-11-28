use garcon_base::errors::{ErrorInput, js_string};
use garcon_js::{
    Number, is_integer,
    json::{Opaque, as_number},
};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    String(String),
    Number(Number),
}

#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcNotification {
    pub method: String,
    pub params: Option<Opaque>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcServerRequest {
    pub id: JsonRpcId,
    pub method: String,
    pub params: Option<Opaque>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnsListResponse {
    pub data: Vec<CodexTurn>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItemsListResponse {
    pub data: Vec<ThreadItemEntry>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItemEntry {
    pub turn_id: String,
    pub item: CodexThreadItem,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurn {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_turn_id: Option<Option<String>>,
    pub items: Vec<CodexThreadItem>,
    pub items_view: CodexItemsView,
    pub status: CodexTurnStatus,
    pub error: Option<Opaque>,
    pub started_at: Option<Number>,
    pub completed_at: Option<Number>,
    pub duration_ms: Option<Number>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexItemsView {
    NotLoaded,
    Summary,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexTurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CodexThreadItem {
    value: Opaque,
    #[serde(skip)]
    pub kind: CodexThreadItemType,
    #[serde(skip)]
    pub id: String,
}

impl CodexThreadItem {
    pub fn payload(&self) -> &Value {
        &self.value
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexThreadItemType {
    UserMessage,
    HookPrompt,
    AgentMessage,
    Plan,
    Reasoning,
    CommandExecution,
    FileChange,
    McpToolCall,
    DynamicToolCall,
    FunctionCallOutput,
    CollabAgentToolCall,
    SubAgentActivity,
    WebSearch,
    ImageView,
    Sleep,
    ImageGeneration,
    EnteredReviewMode,
    ExitedReviewMode,
    ContextCompaction,
}

impl CodexThreadItemType {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "userMessage" => Self::UserMessage,
            "hookPrompt" => Self::HookPrompt,
            "agentMessage" => Self::AgentMessage,
            "plan" => Self::Plan,
            "reasoning" => Self::Reasoning,
            "commandExecution" => Self::CommandExecution,
            "fileChange" => Self::FileChange,
            "mcpToolCall" => Self::McpToolCall,
            "dynamicToolCall" => Self::DynamicToolCall,
            "functionCallOutput" => Self::FunctionCallOutput,
            "collabAgentToolCall" => Self::CollabAgentToolCall,
            "subAgentActivity" => Self::SubAgentActivity,
            "webSearch" => Self::WebSearch,
            "imageView" => Self::ImageView,
            "sleep" => Self::Sleep,
            "imageGeneration" => Self::ImageGeneration,
            "enteredReviewMode" => Self::EnteredReviewMode,
            "exitedReviewMode" => Self::ExitedReviewMode,
            "contextCompaction" => Self::ContextCompaction,
            _ => return None,
        })
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CodexProtocolError(String);

fn invalid(label: impl AsRef<str>) -> CodexProtocolError {
    CodexProtocolError(format!("Invalid {}", label.as_ref()))
}

const CODEX_ERROR_INFO_STRINGS: &[&str] = &[
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "rateLimitExceeded",
    "flexUnavailable",
    "serverOverloaded",
    "modelNotFound",
    "policyCapacityUnavailable",
    "inferenceHookDenied",
    "cyberPolicy",
    "bioPolicy",
    "misalignmentPolicyViolation",
    "tooManyDenials",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
];

pub fn parse_thread_turns_list_response(
    value: &Value,
) -> Result<ThreadTurnsListResponse, CodexProtocolError> {
    let response = protocol_record(Some(value), "thread/turns/list response")?;
    let data = protocol_array(response.get("data"), "thread/turns/list response data")?;
    let next_cursor = nullable_string(response.get("nextCursor"), "thread/turns/list nextCursor")?;
    let backwards_cursor = nullable_string(
        response.get("backwardsCursor"),
        "thread/turns/list backwardsCursor",
    )?;
    let data = data
        .iter()
        .enumerate()
        .map(|(index, value)| parse_codex_turn(value, index))
        .collect::<Result<_, _>>()?;
    Ok(ThreadTurnsListResponse {
        data,
        next_cursor: next_cursor.map(str::to_owned),
        backwards_cursor: backwards_cursor.map(str::to_owned),
    })
}

fn parse_codex_turn(value: &Value, index: usize) -> Result<CodexTurn, CodexProtocolError> {
    let turn = protocol_record(Some(value), format!("turn {index}"))?;
    let id = non_empty_string(turn.get("id"), format!("Codex turn {index} id"))?;
    let items_view = match turn.get("itemsView").and_then(Value::as_str) {
        Some("notLoaded") => CodexItemsView::NotLoaded,
        Some("summary") => CodexItemsView::Summary,
        Some("full") => CodexItemsView::Full,
        _ => return Err(invalid(format!("Codex turn {id} itemsView"))),
    };
    let status = match turn.get("status").and_then(Value::as_str) {
        Some("completed") => CodexTurnStatus::Completed,
        Some("interrupted") => CodexTurnStatus::Interrupted,
        Some("failed") => CodexTurnStatus::Failed,
        Some("inProgress") => CodexTurnStatus::InProgress,
        _ => return Err(invalid(format!("Codex turn {id} status"))),
    };
    let items = protocol_array(turn.get("items"), format!("Codex turn {id} items"))?
        .iter()
        .enumerate()
        .map(|(index, item)| {
            parse_codex_thread_item(item, &format!("Codex turn {id} item {index}"))
        })
        .collect::<Result<_, _>>()?;
    let error = parse_codex_turn_error(turn.get("error"), &format!("Codex turn {id} error"))?;
    Ok(CodexTurn {
        id: id.to_owned(),
        root_turn_id: turn
            .get("rootTurnId")
            .map(|root| {
                nullable_string(Some(root), format!("turn {id} rootTurnId"))
                    .map(|root| root.map(str::to_owned))
            })
            .transpose()?,
        items,
        items_view,
        status,
        error,
        started_at: nullable_number(turn.get("startedAt"), format!("turn {id} startedAt"))?,
        completed_at: nullable_number(turn.get("completedAt"), format!("turn {id} completedAt"))?,
        duration_ms: nullable_number(turn.get("durationMs"), format!("turn {id} durationMs"))?,
    })
}

fn parse_codex_turn_error(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<Opaque>, CodexProtocolError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let error = protocol_record(Some(value), label)?;
    protocol_string(error.get("message"), format!("{label} message"))?;
    nullable_string(
        error.get("additionalDetails"),
        format!("{label} additionalDetails"),
    )?;
    validate_codex_error_info(
        error.get("codexErrorInfo"),
        &format!("{label} codexErrorInfo"),
    )?;
    if let Some(misalignment) = error.get("misalignment").filter(|value| !value.is_null()) {
        let misalignment = protocol_record(Some(misalignment), format!("{label} misalignment"))?;
        for field in ["errorType", "reviewTarget", "detailedExplanation"] {
            nullable_string(
                misalignment.get(field),
                format!("{label} misalignment {field}"),
            )?;
        }
        if let Some(steer) = misalignment.get("steer").filter(|value| !value.is_null()) {
            let steer = protocol_record(Some(steer), format!("{label} misalignment steer"))?;
            protocol_string(
                steer.get("message"),
                format!("{label} misalignment steer message"),
            )?;
        }
    }
    Ok(Some(Opaque::from_value(value.clone())))
}

fn validate_codex_error_info(value: Option<&Value>, label: &str) -> Result<(), CodexProtocolError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    if let Some(value) = value.as_str() {
        return CODEX_ERROR_INFO_STRINGS
            .contains(&value)
            .then_some(())
            .ok_or_else(|| invalid(label));
    }
    let info = protocol_record(Some(value), label)?;
    let Some((kind, detail)) = info.iter().next().filter(|_| info.len() == 1) else {
        return Err(invalid(label));
    };
    let detail = protocol_record(Some(detail), format!("{label} {kind}"))?;
    if kind == "activeTurnNotSteerable" {
        return validate_string_coercion(
            detail.get("turnKind"),
            &["review", "compact"],
            format!("{label} activeTurnNotSteerable turnKind"),
        );
    }
    if !matches!(
        kind.as_str(),
        "httpConnectionFailed"
            | "responseStreamConnectionFailed"
            | "responseStreamDisconnected"
            | "responseTooManyFailedAttempts"
    ) {
        return Err(invalid(label));
    }
    nullable_number(
        detail.get("httpStatusCode"),
        format!("{label} {kind} httpStatusCode"),
    )?;
    Ok(())
}

pub fn parse_thread_items_list_response(
    value: &Value,
) -> Result<ThreadItemsListResponse, CodexProtocolError> {
    let response = protocol_record(Some(value), "thread/items/list response")?;
    let data = protocol_array(response.get("data"), "thread/items/list response data")?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let label = format!("thread/items/list entry {index}");
            let entry = protocol_record(Some(value), &label)?;
            let turn_id =
                non_empty_string(entry.get("turnId"), format!("{label} turnId"))?.to_owned();
            if entry
                .get("outputDeferred")
                .is_some_and(|value| value.as_bool() != Some(false))
            {
                return Err(invalid(format!(
                    "{label} outputDeferred: full output required"
                )));
            }
            let item = parse_codex_thread_item(
                entry.get("item").unwrap_or(&Value::Null),
                &format!("{label} item"),
            )?;
            Ok(ThreadItemEntry { turn_id, item })
        })
        .collect::<Result<_, _>>()?;
    Ok(ThreadItemsListResponse {
        data,
        next_cursor: nullable_string(response.get("nextCursor"), "thread/items/list nextCursor")?
            .map(str::to_owned),
        backwards_cursor: nullable_string(
            response.get("backwardsCursor"),
            "thread/items/list backwardsCursor",
        )?
        .map(str::to_owned),
    })
}

pub fn parse_codex_thread_item(
    value: &Value,
    label: &str,
) -> Result<CodexThreadItem, CodexProtocolError> {
    let item = protocol_record(Some(value), label)?;
    let id = non_empty_string(item.get("id"), format!("{label} id"))?;
    let kind = item
        .get("type")
        .and_then(Value::as_str)
        .and_then(CodexThreadItemType::parse)
        .ok_or_else(|| {
            CodexProtocolError(format!(
                "Unsupported Codex thread item type: {}",
                js_string(string_input(item.get("type")))
            ))
        })?;
    validate_codex_thread_item(item, kind, label)?;
    Ok(CodexThreadItem {
        value: Opaque::from_value(value.clone()),
        kind,
        id: id.to_owned(),
    })
}

pub(super) fn read_live_thread_item(value: &Value) -> Option<CodexThreadItem> {
    let id = value["id"].as_str()?.to_owned();
    let kind = CodexThreadItemType::parse(value["type"].as_str()?)?;
    Some(CodexThreadItem {
        value: Opaque::from_value(value.clone()),
        kind,
        id,
    })
}

fn validate_codex_thread_item(
    item: &Map<String, Value>,
    kind: CodexThreadItemType,
    label: &str,
) -> Result<(), CodexProtocolError> {
    use CodexThreadItemType as Kind;
    let string = |field| protocol_string(item.get(field), format!("{label} {field}"));
    let optional_string = |field| nullable_string(item.get(field), format!("{label} {field}"));
    let array = |field| protocol_array(item.get(field), format!("{label} {field}"));
    let strings = |field| protocol_string_array(item.get(field), format!("{label} {field}"));
    let number = |field| nullable_number(item.get(field), format!("{label} {field}"));
    let coercion = |field, allowed: &[&str]| {
        validate_string_coercion(item.get(field), allowed, format!("{label} {field}"))
    };
    for field in ["startedAtMs", "completedAtMs"] {
        if number(field)?.is_some_and(|value| !is_integer(value.0)) {
            return Err(invalid(format!("{label} {field}")));
        }
    }
    match kind {
        Kind::UserMessage => {
            array("content")?;
            optional_string("clientId")?;
        }
        Kind::HookPrompt => {
            array("fragments")?;
        }
        Kind::AgentMessage => {
            if item.get("phase").is_some_and(|phase| {
                !phase.is_null()
                    && !matches!(
                        phase.as_str(),
                        Some("commentary" | "partial_answer" | "final_answer")
                    )
            }) {
                return Err(invalid(format!("{label} phase")));
            }
            string("text")?;
            if let Some(moderation) = item.get("moderation").filter(|value| !value.is_null()) {
                validate_agent_message_moderation(moderation, &format!("{label} moderation"))?;
            }
        }
        Kind::Plan => {
            string("text")?;
        }
        Kind::Reasoning => {
            strings("summary")?;
            strings("content")?;
        }
        Kind::CommandExecution => {
            string("command")?;
            string("status")?;
            optional_string("aggregatedOutput")?;
            number("exitCode")?;
        }
        Kind::FileChange => {
            array("changes")?;
            string("status")?;
        }
        Kind::McpToolCall => {
            string("server")?;
            string("tool")?;
            string("status")?;
        }
        Kind::DynamicToolCall => {
            optional_string("namespace")?;
            string("tool")?;
            string("status")?;
            if !item.get("contentItems").is_some_and(Value::is_null) {
                array("contentItems")?;
            }
            if !item
                .get("success")
                .is_some_and(|value| value.is_null() || value.is_boolean())
            {
                return Err(invalid(format!("{label} success")));
            }
        }
        Kind::FunctionCallOutput => {
            string("name")?;
            optional_string("namespace")?;
            validate_function_call_output(item.get("output"), &format!("{label} output"))?;
        }
        Kind::CollabAgentToolCall => {
            coercion(
                "tool",
                &[
                    "spawnAgent",
                    "sendInput",
                    "resumeAgent",
                    "wait",
                    "closeAgent",
                    "sendMessage",
                    "followupTask",
                    "interruptAgent",
                    "listAgents",
                ],
            )?;
            coercion(
                "status",
                &["inProgress", "completed", "failed", "interrupted"],
            )?;
            string("senderThreadId")?;
            strings("receiverThreadIds")?;
            optional_string("prompt")?;
            optional_string("model")?;
            optional_string("reasoningEffort")?;
            protocol_record(item.get("agentsStates"), format!("{label} agentsStates"))?;
        }
        Kind::SubAgentActivity => {
            coercion(
                "kind",
                &["started", "interacted", "interrupted", "completed"],
            )?;
            string("agentThreadId")?;
            string("agentPath")?;
            optional_string("model")?;
            if optional_string("reasoningEffort")? == Some("") {
                return Err(invalid(format!("{label} reasoningEffort")));
            }
        }
        Kind::WebSearch => {
            string("query")?;
            if !item.get("action").is_some_and(Value::is_null) {
                protocol_record(item.get("action"), format!("{label} action"))?;
            }
        }
        Kind::ImageView => {
            string("path")?;
        }
        Kind::Sleep => {
            if !item
                .get("durationMs")
                .and_then(as_number)
                .is_some_and(|value| value.is_finite() && value >= 0.0)
            {
                return Err(invalid(format!("{label} durationMs")));
            }
        }
        Kind::ImageGeneration => {
            string("status")?;
            optional_string("revisedPrompt")?;
            if item.contains_key("fileId") {
                string("fileId")?;
            } else {
                string("result")?;
            }
            if item.contains_key("result") {
                string("result")?;
            }
            optional_string("savedPath")?;
            optional_string("generationId")?;
            if item.contains_key("inputImages") {
                for (index, value) in array("inputImages")?.iter().enumerate() {
                    let input =
                        protocol_record(Some(value), format!("{label} inputImages {index}"))?;
                    protocol_string(
                        input.get("path"),
                        format!("{label} inputImages {index} path"),
                    )?;
                    protocol_string(
                        input.get("sha256"),
                        format!("{label} inputImages {index} sha256"),
                    )?;
                }
            }
        }
        Kind::EnteredReviewMode | Kind::ExitedReviewMode => {
            string("review")?;
        }
        Kind::ContextCompaction => {}
    }
    Ok(())
}

fn validate_agent_message_moderation(value: &Value, label: &str) -> Result<(), CodexProtocolError> {
    let moderation = protocol_record(Some(value), label)?;
    if !moderation.get("moderated").is_some_and(Value::is_boolean) {
        return Err(invalid(format!("{label} moderated")));
    }
    let Some(display) = moderation.get("display").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let label = format!("{label} display");
    let display = protocol_record(Some(display), &label)?;
    if display.get("version").and_then(as_number) != Some(1.0) {
        return Err(invalid(format!("{label} version")));
    }
    match display.get("mode").and_then(Value::as_str) {
        Some("show") => {
            if !matches!(
                display.get("trustedContacts").and_then(Value::as_str),
                Some("check" | "skip")
            ) {
                return Err(invalid(format!("{label} trustedContacts")));
            }
            let Some(annotation) = display.get("annotation").filter(|value| !value.is_null())
            else {
                return Ok(());
            };
            let annotation = protocol_record(Some(annotation), format!("{label} annotation"))?;
            if annotation.get("kind").and_then(Value::as_str) != Some("wellbeingHelpline") {
                return Err(invalid(format!("{label} annotation kind")));
            }
            if !matches!(
                annotation.get("subject").and_then(Value::as_str),
                Some("answer" | "prompt")
            ) {
                return Err(invalid(format!("{label} annotation subject")));
            }
        }
        Some("hide") => {
            let replacement =
                protocol_record(display.get("replacement"), format!("{label} replacement"))?;
            if replacement.get("kind").and_then(Value::as_str) != Some("wellbeingPromptHelpline") {
                return Err(invalid(format!("{label} replacement kind")));
            }
        }
        Some("block") => {
            let reason = protocol_record(display.get("reason"), format!("{label} reason"))?;
            match reason.get("kind").and_then(Value::as_str) {
                Some("protection") => {
                    protocol_string(
                        reason.get("protectionType"),
                        format!("{label} reason protectionType"),
                    )?;
                }
                Some("cyber") => {
                    if reason
                        .get("trustedAccess")
                        .is_some_and(|value| !value.is_null() && !value.is_boolean())
                    {
                        return Err(invalid(format!("{label} reason trustedAccess")));
                    }
                }
                _ => return Err(invalid(format!("{label} reason kind"))),
            }
        }
        _ => return Err(invalid(format!("{label} mode"))),
    }
    Ok(())
}

fn validate_function_call_output(
    value: Option<&Value>,
    label: &str,
) -> Result<(), CodexProtocolError> {
    if value.is_some_and(Value::is_string) {
        return Ok(());
    }
    for (index, content) in protocol_array(value, label)?.iter().enumerate() {
        let label = format!("{label} item {index}");
        let item = protocol_record(Some(content), &label)?;
        let string = |field| protocol_string(item.get(field), format!("{label} {field}"));
        match item.get("type").and_then(Value::as_str) {
            Some("input_text") => {
                string("text")?;
            }
            Some("input_image") => {
                string("image_url")?;
                if let Some(detail) = item.get("detail").filter(|value| !value.is_null()) {
                    validate_string_coercion(
                        Some(detail),
                        &["auto", "low", "high", "original"],
                        format!("{label} detail"),
                    )?;
                }
            }
            Some("input_audio") => {
                if item.contains_key("audio_url") {
                    string("audio_url")?;
                } else {
                    string("file_id")?;
                }
                if item.contains_key("file_id") {
                    string("file_id")?;
                }
            }
            Some("encrypted_content") => {
                string("encrypted_content")?;
            }
            _ => return Err(invalid(format!("{label} type"))),
        }
    }
    Ok(())
}

fn validate_string_coercion(
    value: Option<&Value>,
    allowed: &[&str],
    label: impl AsRef<str>,
) -> Result<(), CodexProtocolError> {
    allowed
        .contains(&js_string(string_input(value)).as_ref())
        .then_some(())
        .ok_or_else(|| invalid(label))
}

fn string_input(value: Option<&Value>) -> ErrorInput<'_> {
    value.map_or(ErrorInput::Undefined, ErrorInput::Json)
}

fn non_empty_string(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<&str, CodexProtocolError> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(label))
}

fn protocol_string(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<&str, CodexProtocolError> {
    value.and_then(Value::as_str).ok_or_else(|| invalid(label))
}

fn protocol_array(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<&[Value], CodexProtocolError> {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(label))
}

fn protocol_string_array(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<(), CodexProtocolError> {
    protocol_array(value, label.as_ref())?
        .iter()
        .all(Value::is_string)
        .then_some(())
        .ok_or_else(|| invalid(label))
}

fn protocol_record(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<&Map<String, Value>, CodexProtocolError> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(label))
}

fn nullable_string(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<Option<&str>, CodexProtocolError> {
    match value.filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => protocol_string(Some(value), label).map(Some),
    }
}

fn nullable_number(
    value: Option<&Value>,
    label: impl AsRef<str>,
) -> Result<Option<Number>, CodexProtocolError> {
    match value.filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => as_number(value)
            .filter(|value| value.is_finite())
            .map(|value| Some(Number(value)))
            .ok_or_else(|| invalid(label)),
    }
}
