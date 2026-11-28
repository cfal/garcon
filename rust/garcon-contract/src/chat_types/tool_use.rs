use garcon_js::{Number, OptionalNullable, json::Opaque};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::Value;

use crate::chat_message_coercion::{
    AllowedPrompt, AskUserQuestionPrompt, OptionalChange, as_allowed_prompts,
    as_ask_user_questions, as_codex_subagent_input_items, as_optional_boolean, as_optional_changes,
    as_optional_number, as_optional_string, as_optional_string_array, as_record, as_string_array,
    str,
};
use crate::chat_plan::{
    CursorPlanPhase, CursorPlanTodo, PlanStep, TodoItem, as_cursor_plan_phases,
    as_cursor_plan_todos, coerce_plan_steps, coerce_todo_items,
};
use crate::tool_schedule::{ToolScheduleRequest, parse_tool_schedule_request};

macro_rules! emit_field {
    (required, $map:ident, $key:literal, $field:ident) => {
        $map.serialize_entry($key, $field)?;
    };
    (optional, $map:ident, $key:literal, $field:ident) => {
        if let Some(value) = $field {
            $map.serialize_entry($key, value)?;
        }
    };
    (nullable, $map:ident, $key:literal, $field:ident) => {
        if !$field.is_absent() {
            $map.serialize_entry($key, $field)?;
        }
    };
}

macro_rules! tool_messages {
    ($($variant:ident($tag:literal) { $($key:literal => $field:ident: $type:ty [$presence:ident],)* })*) => {
        /// Canonical tool use carried by chat rows and permission requests.
        #[derive(Debug, Clone, PartialEq)]
        pub enum ToolUseChatMessage {
            $($variant { timestamp: String, tool_id: String, $($field: $type),* }),*
        }

        impl ToolUseChatMessage {
            pub fn message_type(&self) -> &'static str {
                match self {
                    $(Self::$variant { .. } => $tag),*
                }
            }

            pub fn timestamp(&self) -> &str {
                match self {
                    $(Self::$variant { timestamp, .. } => timestamp),*
                }
            }

            pub fn tool_id(&self) -> &str {
                match self {
                    $(Self::$variant { tool_id, .. } => tool_id),*
                }
            }

            pub fn has_type(value: &str) -> bool {
                matches!(value, $($tag)|*)
            }
        }

        impl Serialize for ToolUseChatMessage {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("timestamp", self.timestamp())?;
                map.serialize_entry("toolId", self.tool_id())?;
                match self {
                    $(Self::$variant { $($field,)* .. } => {
                        $(emit_field!($presence, map, $key, $field);)*
                    })*
                }
                map.serialize_entry("type", self.message_type())?;
                map.end()
            }
        }
    };
}

tool_messages! {
    Bash("bash-tool-use") {
        "command" => command: String [required],
        "description" => description: Option<String> [optional],
    }
    Exec("exec-tool-use") {
        "code" => code: String [required],
        "language" => language: String [required],
    }
    Wait("wait-tool-use") {
        "executionId" => execution_id: String [required],
        "yieldTimeMs" => yield_time_ms: Option<Number> [optional],
        "maxTokens" => max_tokens: Option<Number> [optional],
        "terminate" => terminate: Option<bool> [optional],
    }
    Read("read-tool-use") {
        "filePath" => file_path: String [required],
        "offset" => offset: Option<Number> [optional],
        "limit" => limit: Option<Number> [optional],
        "endLine" => end_line: Option<Number> [optional],
    }
    List("list-tool-use") {
        "path" => path: Option<String> [optional],
    }
    Edit("edit-tool-use") {
        "filePath" => file_path: Option<String> [optional],
        "oldString" => old_string: Option<String> [optional],
        "newString" => new_string: Option<String> [optional],
        "changes" => changes: Option<Vec<OptionalChange>> [optional],
    }
    Write("write-tool-use") {
        "filePath" => file_path: String [required],
        "content" => content: Option<String> [optional],
    }
    ApplyPatch("apply-patch-tool-use") {
        "filePath" => file_path: Option<String> [optional],
        "oldString" => old_string: Option<String> [optional],
        "newString" => new_string: Option<String> [optional],
        "patch" => patch: Option<String> [optional],
    }
    Grep("grep-tool-use") {
        "pattern" => pattern: Option<String> [optional],
        "path" => path: Option<String> [optional],
    }
    Glob("glob-tool-use") {
        "pattern" => pattern: Option<String> [optional],
        "path" => path: Option<String> [optional],
    }
    WebSearch("web-search-tool-use") {
        "query" => query: String [required],
    }
    WebFetch("web-fetch-tool-use") {
        "url" => url: String [required],
        "prompt" => prompt: Option<String> [optional],
    }
    TodoWrite("todo-write-tool-use") {
        "todos" => todos: Option<Vec<TodoItem>> [optional],
    }
    TodoRead("todo-read-tool-use") {}
    BackgroundTask("background-task-tool-use") {
        "action" => action: BackgroundTaskAction [required],
        "taskId" => task_id: Option<String> [optional],
        "input" => input: Option<String> [optional],
    }
    AgentMessage("agent-message-tool-use") {
        "recipient" => recipient: String [required],
        "message" => message: String [required],
    }
    Task("task-tool-use") {
        "subagentType" => subagent_type: Option<String> [optional],
        "description" => description: Option<String> [optional],
        "prompt" => prompt: Option<String> [optional],
        "model" => model: Option<String> [optional],
        "resume" => resume: Option<String> [optional],
    }
    CodexSubagent("codex-subagent-tool-use") {
        "action" => action: CodexSubagentAction [required],
        "details" => details: Box<CodexSubagentDetails> [required],
    }
    WriteStdin("write-stdin-tool-use") {
        "input" => input: Opaque [required],
    }
    Schedule("schedule-tool-use") {
        "request" => request: ToolScheduleRequest [required],
        "nativeName" => native_name: Option<String> [optional],
    }
    UpdatePlan("update-plan-tool-use") {
        "todos" => todos: Option<Vec<PlanStep>> [optional],
    }
    EnterPlanMode("enter-plan-mode-tool-use") {}
    AntigravityEnterPlanMode("antigravity-enter-plan-mode-tool-use") {
        "reason" => reason: String [required],
    }
    AntigravityExitPlanMode("antigravity-exit-plan-mode-tool-use") {
        "plan" => plan: String [required],
    }
    ExitPlanMode("exit-plan-mode-tool-use") {
        "plan" => plan: String [required],
        "allowedPrompts" => allowed_prompts: Option<Vec<AllowedPrompt>> [optional],
    }
    AskUserQuestion("ask-user-question-tool-use") {
        "title" => title: Option<String> [optional],
        "questions" => questions: Vec<AskUserQuestionPrompt> [required],
    }
    CursorCreatePlan("cursor-create-plan-tool-use") {
        "plan" => plan: String [required],
        "name" => name: Option<String> [optional],
        "overview" => overview: Option<String> [optional],
        "todos" => todos: Option<Vec<CursorPlanTodo>> [optional],
        "isProject" => is_project: Option<bool> [optional],
        "phases" => phases: Option<Vec<CursorPlanPhase>> [optional],
    }
    AmpFinder("amp-finder-tool-use") {
        "query" => query: Option<String> [optional],
    }
    AmpOracle("amp-oracle-tool-use") {
        "task" => task: Option<String> [optional],
        "context" => context: Option<String> [optional],
        "files" => files: Option<Vec<String>> [optional],
    }
    AmpLibrarian("amp-librarian-tool-use") {
        "query" => query: Option<String> [optional],
        "context" => context: Option<String> [optional],
    }
    AmpSkill("amp-skill-tool-use") {
        "name" => name: Option<String> [optional],
    }
    AmpMermaid("amp-mermaid-tool-use") {}
    AmpHandoff("amp-handoff-tool-use") {
        "goal" => goal: Option<String> [optional],
    }
    AmpLookAt("amp-look-at-tool-use") {
        "path" => path: Option<String> [optional],
        "objective" => objective: Option<String> [optional],
    }
    AmpFindThread("amp-find-thread-tool-use") {
        "query" => query: Option<String> [optional],
    }
    AmpReadThread("amp-read-thread-tool-use") {
        "threadId" => thread_id: Option<String> [optional],
        "goal" => goal: Option<String> [optional],
    }
    AmpTaskList("amp-task-list-tool-use") {
        "action" => action: Option<String> [optional],
        "taskId" => task_id: Option<String> [optional],
        "title" => title: Option<String> [optional],
        "status" => status: Option<String> [optional],
    }
    PiToolSearch("pi-tool-search-tool-use") {
        "query" => query: String [required],
        "limit" => limit: Option<Number> [optional],
    }
    ClaudeToolSearch("claude-tool-search-tool-use") {
        "query" => query: String [required],
        "maxResults" => max_results: Option<Number> [optional],
    }
    ClaudeMonitor("claude-monitor-tool-use") {
        "description" => description: String [required],
        "timeoutMs" => timeout_ms: Option<Number> [optional],
        "command" => command: Option<String> [optional],
        "webSocketUrl" => web_socket_url: Option<String> [optional],
        "webSocketProtocols" => web_socket_protocols: Option<Vec<String>> [optional],
        "persistent" => persistent: Option<bool> [optional],
        "allowedDomains" => allowed_domains: Option<Vec<String>> [optional],
    }
    External("external-tool-use") {
        "name" => name: String [required],
        "input" => input: Opaque [required],
        "namespace" => namespace: OptionalNullable<String> [nullable],
    }
    Mcp("mcp-tool-use") {
        "server" => server: String [required],
        "tool" => tool: String [required],
        "input" => input: Opaque [required],
    }
    RequestPermissions("request-permissions-tool-use") {
        "permissions" => permissions: Opaque [required],
        "reason" => reason: Option<String> [optional],
    }
    Unknown("unknown-tool-use") {
        "rawName" => raw_name: String [required],
        "input" => input: Opaque [required],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskAction {
    List,
    Status,
    Stop,
    SendInput,
}

impl BackgroundTaskAction {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "list" => Some(Self::List),
            "status" => Some(Self::Status),
            "stop" => Some(Self::Stop),
            "send_input" => Some(Self::SendInput),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexSubagentAction {
    SpawnAgent,
    SendInput,
    SendMessage,
    FollowupTask,
    WaitAgent,
    InterruptAgent,
    ListAgents,
    CloseAgent,
    ResumeAgent,
    AgentStatus,
}

impl CodexSubagentAction {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "spawn_agent" => Some(Self::SpawnAgent),
            "send_input" => Some(Self::SendInput),
            "send_message" => Some(Self::SendMessage),
            "followup_task" => Some(Self::FollowupTask),
            "wait_agent" => Some(Self::WaitAgent),
            "interrupt_agent" => Some(Self::InterruptAgent),
            "list_agents" => Some(Self::ListAgents),
            "close_agent" => Some(Self::CloseAgent),
            "resume_agent" => Some(Self::ResumeAgent),
            "agent_status" => Some(Self::AgentStatus),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubagentInputItem {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexSubagentStatus {
    PendingInit,
    Running,
    Interrupted,
    Completed,
    Errored,
    Shutdown,
    NotFound,
}

impl CodexSubagentStatus {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "pendingInit" => Some(Self::PendingInit),
            "running" => Some(Self::Running),
            "interrupted" => Some(Self::Interrupted),
            "completed" => Some(Self::Completed),
            "errored" => Some(Self::Errored),
            "shutdown" => Some(Self::Shutdown),
            "notFound" => Some(Self::NotFound),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexSubagentLifecycleSource {
    Structured,
    Legacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexSubagentState {
    pub status: CodexSubagentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubagentDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_turns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupt: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<CodexSubagentInputItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_states: Option<IndexMap<String, CodexSubagentState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle_source: Option<CodexSubagentLifecycleSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<String>,
}

pub fn codex_subagent_source_fingerprint(content: &str) -> String {
    fingerprint_code_units(content.encode_utf16())
}

pub fn codex_subagent_source_fingerprint_utf16(content: &[u16]) -> String {
    fingerprint_code_units(content.iter().copied())
}

fn fingerprint_code_units(content: impl Iterator<Item = u16>) -> String {
    let (mut a, mut b) = (0x811c_9dc5_u32, 0x9e37_79b9_u32);
    let mut len = 0;
    for code in content {
        len += 1;
        a = (a ^ u32::from(code)).wrapping_mul(0x0100_0193);
        b = (b ^ u32::from(code)).wrapping_mul(0x85eb_ca6b);
    }
    format!("codex-subagent:{len}:{a:08x}{b:08x}")
}

fn parse_codex_subagent_states(value: &Value) -> Option<IndexMap<String, CodexSubagentState>> {
    let raw = value.as_object()?;
    let mut entries: Vec<_> = raw.iter().collect();
    entries.sort_by_key(|(key, _)| garcon_js::array_index(key).unwrap_or(u64::MAX));
    let states: IndexMap<_, _> = entries
        .into_iter()
        .filter_map(|(key, value)| {
            // Assignment to __proto__ changes the prototype, not the own keys.
            if key == "__proto__" {
                return None;
            }
            let status = CodexSubagentStatus::parse(value["status"].as_str()?)?;
            let message = value["message"].as_str().map(str::to_owned);
            Some((key.clone(), CodexSubagentState { status, message }))
        })
        .collect();
    (!states.is_empty() || raw.is_empty()).then_some(states)
}

fn parse_codex_subagent_details(value: &Value) -> CodexSubagentDetails {
    let raw = as_record(value);
    let text = |key| raw.get(key).and_then(Value::as_str).map(str::to_owned);
    CodexSubagentDetails {
        target: text("target"),
        thread_id: text("threadId"),
        targets: as_string_array(&value["targets"]),
        message: text("message"),
        task_name: text("taskName"),
        agent_type: text("agentType"),
        model: text("model"),
        reasoning_effort: text("reasoningEffort"),
        service_tier: text("serviceTier"),
        fork_context: as_optional_boolean(&value["forkContext"]),
        fork_turns: text("forkTurns"),
        timeout_ms: as_optional_number(&value["timeoutMs"]),
        path_prefix: text("pathPrefix"),
        interrupt: as_optional_boolean(&value["interrupt"]),
        items: as_codex_subagent_input_items(&value["items"]),
        agent_states: parse_codex_subagent_states(&value["agentStates"]),
        lifecycle_source: match value["lifecycleSource"].as_str() {
            Some("structured") => Some(CodexSubagentLifecycleSource::Structured),
            Some("legacy") => Some(CodexSubagentLifecycleSource::Legacy),
            _ => None,
        },
        source_fingerprint: text("sourceFingerprint"),
    }
}

fn opaque_record(value: &Value) -> Opaque {
    Value::Object(as_record(value).clone()).into()
}

fn parse_namespace(value: Option<&Value>) -> OptionalNullable<String> {
    match value {
        Some(Value::Null) => OptionalNullable::NULL,
        Some(Value::String(value)) => OptionalNullable::some(value.clone()),
        _ => OptionalNullable::ABSENT,
    }
}

/// Parses the tool-use variants, including the one persisted Cursor alias.
pub fn parse_tool_use_message(value: &Value) -> Option<ToolUseChatMessage> {
    let data = value.as_object()?;
    let get = |key| data.get(key).unwrap_or(&Value::Null);
    let tag = match get("type").as_str()? {
        "cursor-ask-question-tool-use" => "ask-user-question-tool-use",
        tag => tag,
    };
    let timestamp = str(get("timestamp")).to_owned();
    let tool_id = str(get("toolId")).to_owned();
    let optional = |key| as_optional_string(get(key)).map(str::to_owned);
    let numeric = |key| as_optional_number(get(key));
    let flag = |key| as_optional_boolean(get(key));
    let fallback = |key| str(get(key)).to_owned();
    Some(match tag {
        "bash-tool-use" => ToolUseChatMessage::Bash {
            timestamp,
            tool_id,
            command: optional("command")?,
            description: optional("description"),
        },
        "exec-tool-use" => ToolUseChatMessage::Exec {
            timestamp,
            tool_id,
            code: optional("code")?,
            language: optional("language")?,
        },
        "wait-tool-use" => ToolUseChatMessage::Wait {
            timestamp,
            tool_id,
            execution_id: optional("executionId")?,
            yield_time_ms: numeric("yieldTimeMs"),
            max_tokens: numeric("maxTokens"),
            terminate: flag("terminate"),
        },
        "read-tool-use" => ToolUseChatMessage::Read {
            timestamp,
            tool_id,
            file_path: optional("filePath")?,
            offset: numeric("offset"),
            limit: numeric("limit"),
            end_line: numeric("endLine"),
        },
        "list-tool-use" => ToolUseChatMessage::List {
            timestamp,
            tool_id,
            path: optional("path"),
        },
        "edit-tool-use" => ToolUseChatMessage::Edit {
            timestamp,
            tool_id,
            file_path: optional("filePath"),
            old_string: optional("oldString"),
            new_string: optional("newString"),
            changes: as_optional_changes(get("changes")),
        },
        "write-tool-use" => ToolUseChatMessage::Write {
            timestamp,
            tool_id,
            file_path: optional("filePath")?,
            content: optional("content"),
        },
        "apply-patch-tool-use" => ToolUseChatMessage::ApplyPatch {
            timestamp,
            tool_id,
            file_path: optional("filePath"),
            old_string: optional("oldString"),
            new_string: optional("newString"),
            patch: optional("patch"),
        },
        "grep-tool-use" => ToolUseChatMessage::Grep {
            timestamp,
            tool_id,
            pattern: optional("pattern"),
            path: optional("path"),
        },
        "glob-tool-use" => ToolUseChatMessage::Glob {
            timestamp,
            tool_id,
            pattern: optional("pattern"),
            path: optional("path"),
        },
        "web-search-tool-use" => ToolUseChatMessage::WebSearch {
            timestamp,
            tool_id,
            query: optional("query")?,
        },
        "web-fetch-tool-use" => ToolUseChatMessage::WebFetch {
            timestamp,
            tool_id,
            url: optional("url")?,
            prompt: optional("prompt"),
        },
        "todo-write-tool-use" => ToolUseChatMessage::TodoWrite {
            timestamp,
            tool_id,
            todos: coerce_todo_items(get("todos")),
        },
        "todo-read-tool-use" => ToolUseChatMessage::TodoRead { timestamp, tool_id },
        "background-task-tool-use" => {
            let action = BackgroundTaskAction::parse(get("action").as_str()?)?;
            let task_id = optional("taskId");
            let input = optional("input");
            if (data.contains_key("taskId") && task_id.is_none())
                || (data.contains_key("input") && input.is_none())
                || (action != BackgroundTaskAction::List
                    && task_id.as_deref().is_none_or(str::is_empty))
                || (action == BackgroundTaskAction::SendInput && input.is_none())
            {
                return None;
            }
            ToolUseChatMessage::BackgroundTask {
                timestamp,
                tool_id,
                action,
                task_id,
                input,
            }
        }
        "agent-message-tool-use" => ToolUseChatMessage::AgentMessage {
            timestamp,
            tool_id,
            recipient: optional("recipient").filter(|value| !value.is_empty())?,
            message: optional("message")?,
        },
        "task-tool-use" => ToolUseChatMessage::Task {
            timestamp,
            tool_id,
            subagent_type: optional("subagentType"),
            description: optional("description"),
            prompt: optional("prompt"),
            model: optional("model"),
            resume: optional("resume"),
        },
        "codex-subagent-tool-use" => ToolUseChatMessage::CodexSubagent {
            timestamp,
            tool_id,
            action: CodexSubagentAction::parse(get("action").as_str()?)?,
            details: Box::new(parse_codex_subagent_details(get("details"))),
        },
        "write-stdin-tool-use" => ToolUseChatMessage::WriteStdin {
            timestamp,
            tool_id,
            input: opaque_record(get("input")),
        },
        "schedule-tool-use" => ToolUseChatMessage::Schedule {
            timestamp,
            tool_id,
            request: parse_tool_schedule_request(get("request"))?,
            native_name: optional("nativeName"),
        },
        "update-plan-tool-use" => ToolUseChatMessage::UpdatePlan {
            timestamp,
            tool_id,
            todos: coerce_plan_steps(get("todos")),
        },
        "enter-plan-mode-tool-use" => ToolUseChatMessage::EnterPlanMode { timestamp, tool_id },
        "antigravity-enter-plan-mode-tool-use" => ToolUseChatMessage::AntigravityEnterPlanMode {
            timestamp,
            tool_id,
            reason: optional("reason")?,
        },
        "antigravity-exit-plan-mode-tool-use" => ToolUseChatMessage::AntigravityExitPlanMode {
            timestamp,
            tool_id,
            plan: optional("plan")?,
        },
        "exit-plan-mode-tool-use" => ToolUseChatMessage::ExitPlanMode {
            timestamp,
            tool_id,
            plan: optional("plan")?,
            allowed_prompts: as_allowed_prompts(get("allowedPrompts")),
        },
        "ask-user-question-tool-use" => ToolUseChatMessage::AskUserQuestion {
            timestamp,
            tool_id,
            title: optional("title"),
            questions: as_ask_user_questions(get("questions")),
        },
        "cursor-create-plan-tool-use" => ToolUseChatMessage::CursorCreatePlan {
            timestamp,
            tool_id,
            plan: optional("plan")?,
            name: optional("name"),
            overview: optional("overview"),
            todos: as_cursor_plan_todos(get("todos")),
            is_project: flag("isProject"),
            phases: as_cursor_plan_phases(get("phases")),
        },
        "amp-finder-tool-use" => ToolUseChatMessage::AmpFinder {
            timestamp,
            tool_id,
            query: optional("query"),
        },
        "amp-oracle-tool-use" => ToolUseChatMessage::AmpOracle {
            timestamp,
            tool_id,
            task: optional("task"),
            context: optional("context"),
            files: as_string_array(get("files")),
        },
        "amp-librarian-tool-use" => ToolUseChatMessage::AmpLibrarian {
            timestamp,
            tool_id,
            query: optional("query"),
            context: optional("context"),
        },
        "amp-skill-tool-use" => ToolUseChatMessage::AmpSkill {
            timestamp,
            tool_id,
            name: optional("name"),
        },
        "amp-mermaid-tool-use" => ToolUseChatMessage::AmpMermaid { timestamp, tool_id },
        "amp-handoff-tool-use" => ToolUseChatMessage::AmpHandoff {
            timestamp,
            tool_id,
            goal: optional("goal"),
        },
        "amp-look-at-tool-use" => ToolUseChatMessage::AmpLookAt {
            timestamp,
            tool_id,
            path: optional("path"),
            objective: optional("objective"),
        },
        "amp-find-thread-tool-use" => ToolUseChatMessage::AmpFindThread {
            timestamp,
            tool_id,
            query: optional("query"),
        },
        "amp-read-thread-tool-use" => ToolUseChatMessage::AmpReadThread {
            timestamp,
            tool_id,
            thread_id: optional("threadId"),
            goal: optional("goal"),
        },
        "amp-task-list-tool-use" => ToolUseChatMessage::AmpTaskList {
            timestamp,
            tool_id,
            action: optional("action"),
            task_id: optional("taskId"),
            title: optional("title"),
            status: optional("status"),
        },
        "pi-tool-search-tool-use" => ToolUseChatMessage::PiToolSearch {
            timestamp,
            tool_id,
            query: fallback("query"),
            limit: numeric("limit"),
        },
        "claude-tool-search-tool-use" => ToolUseChatMessage::ClaudeToolSearch {
            timestamp,
            tool_id,
            query: fallback("query"),
            max_results: numeric("maxResults"),
        },
        "claude-monitor-tool-use" => ToolUseChatMessage::ClaudeMonitor {
            timestamp,
            tool_id,
            description: fallback("description"),
            timeout_ms: numeric("timeoutMs"),
            command: optional("command"),
            web_socket_url: optional("webSocketUrl"),
            web_socket_protocols: as_optional_string_array(get("webSocketProtocols")),
            persistent: flag("persistent"),
            allowed_domains: as_optional_string_array(get("allowedDomains")),
        },
        "external-tool-use" => ToolUseChatMessage::External {
            timestamp,
            tool_id,
            name: fallback("name"),
            input: opaque_record(get("input")),
            namespace: parse_namespace(data.get("namespace")),
        },
        "mcp-tool-use" => ToolUseChatMessage::Mcp {
            timestamp,
            tool_id,
            server: fallback("server"),
            tool: fallback("tool"),
            input: opaque_record(get("input")),
        },
        "request-permissions-tool-use" => ToolUseChatMessage::RequestPermissions {
            timestamp,
            tool_id,
            permissions: opaque_record(get("permissions")),
            reason: optional("reason"),
        },
        "unknown-tool-use" => ToolUseChatMessage::Unknown {
            timestamp,
            tool_id,
            raw_name: fallback("rawName"),
            input: opaque_record(get("input")),
        },
        _ => return None,
    })
}
