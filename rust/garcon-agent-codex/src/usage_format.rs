use garcon_agents_common::{
    jsonl::{JsonlLineResult, parse_first_jsonl_value},
    usage::usage_record::{
        MalformedUsage, NativeUsageTokenTotals, TranscriptUsageFormat, UsageLine, UsageRecord,
        UsageSpeed, parse_timestamp_ms,
    },
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{
    Number, is_safe_integer,
    json::{as_number, stringify},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const FORK_COPY_MAX_GAP_MS: f64 = 1000.0;

// https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/protocol/src/protocol.rs#L2576-L2599
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct CodexTokenUsage {
    input_tokens: f64,
    cached_input_tokens: f64,
    cache_write_input_tokens: f64,
    output_tokens: f64,
    reasoning_output_tokens: f64,
    total_tokens: f64,
}

impl CodexTokenUsage {
    fn fields(self) -> [f64; 6] {
        [
            self.input_tokens,
            self.cached_input_tokens,
            self.cache_write_input_tokens,
            self.output_tokens,
            self.reasoning_output_tokens,
            self.total_tokens,
        ]
    }

    fn valid(self) -> Option<Self> {
        (self
            .fields()
            .into_iter()
            .all(|n| n >= 0.0 && is_safe_integer(n))
            && self.cached_input_tokens + self.cache_write_input_tokens <= self.input_tokens
            && self.reasoning_output_tokens <= self.output_tokens
            && self.total_tokens >= self.input_tokens + self.output_tokens)
            .then_some(self)
    }

    fn signature(&self) -> String {
        stringify(&json!(self))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageTurn {
    id: String,
    model: String,
    speed: Option<UsageSpeed>,
    has_context: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageState {
    model: String,
    thread_model: Option<String>,
    thread_speed: Option<UsageSpeed>,
    turn: Option<UsageTurn>,
    session_id: String,
    saw_session_meta: bool,
    last_usage_signature: Option<String>,
    last_cumulative_usage: Option<CodexTokenUsage>,
    fork_thread_id: Option<String>,
    fork_copy_anchor_ms: Option<Number>,
    saw_usage_record: bool,
}

pub fn create_codex_usage_state() -> CodexUsageState {
    CodexUsageState::default()
}

fn read_token_usage(value: &Value) -> Option<CodexTokenUsage> {
    if !value.is_object() {
        return None;
    }
    let input = as_number(&value["input_tokens"])?;
    let output = as_number(&value["output_tokens"])?;
    let number_or = |key, default| {
        let field = &value[key];
        if field.is_null() {
            Some(default)
        } else {
            as_number(field)
        }
    };
    CodexTokenUsage {
        input_tokens: input,
        cached_input_tokens: number_or("cached_input_tokens", 0.0)?,
        cache_write_input_tokens: number_or("cache_write_input_tokens", 0.0)?,
        output_tokens: output,
        reasoning_output_tokens: number_or("reasoning_output_tokens", 0.0)?,
        total_tokens: number_or("total_tokens", input + output)?,
    }
    .valid()
}

fn combine_usage(
    left: Option<CodexTokenUsage>,
    right: CodexTokenUsage,
    sign: f64,
) -> Option<CodexTokenUsage> {
    let left = left.map_or([0.0; 6], CodexTokenUsage::fields);
    let right = right.fields();
    let [input, cached, write, output, reasoning, total] =
        std::array::from_fn(|i| left[i] + sign * right[i]);
    CodexTokenUsage {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: write,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: total,
    }
    .valid()
}

fn native_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn is_forked_session_meta(payload: &Value) -> bool {
    payload["forked_from_id"].is_string()
        || payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"].is_string()
}

fn usage_speed_from_service_tier(tier: &Value) -> UsageSpeed {
    match tier.as_str() {
        Some("priority" | "fast") => UsageSpeed::Fast,
        Some("default") => UsageSpeed::Standard,
        Some("flex") => UsageSpeed::Flex,
        Some("ultrafast") => UsageSpeed::Ultrafast,
        None if tier.is_null() => UsageSpeed::Standard,
        _ => UsageSpeed::Unknown,
    }
}

fn consume_fork_copy(
    state: &mut CodexUsageState,
    timestamp_ms: i64,
    thread_id: Option<&str>,
) -> bool {
    let Some(anchor) = state.fork_copy_anchor_ms else {
        return false;
    };
    let belongs_to_child = thread_id.is_some() && thread_id == state.fork_thread_id.as_deref();
    if !belongs_to_child && timestamp_ms as f64 - anchor.0 < FORK_COPY_MAX_GAP_MS {
        state.fork_copy_anchor_ms = Some(Number(timestamp_ms as f64));
        return true;
    }
    state.fork_copy_anchor_ms = None;
    state.last_usage_signature = None;
    false
}

fn usage_record(
    session_id: &str,
    model: &str,
    timestamp_ms: i64,
    usage: CodexTokenUsage,
    speed: Option<UsageSpeed>,
    dedupe_key: String,
) -> UsageLine {
    UsageLine::Record(UsageRecord {
        timestamp_ms,
        model: model.into(),
        session_id: session_id.into(),
        totals: NativeUsageTokenTotals {
            uncached_input_tokens: Number(
                usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
            ),
            cached_input_tokens: Number(usage.cached_input_tokens),
            cache_write_tokens: Number(usage.cache_write_input_tokens),
            output_tokens: Number(usage.output_tokens),
            reasoning_tokens: Number(usage.reasoning_output_tokens),
        },
        cache_write_1h_tokens: Number(0.0),
        speed: speed.unwrap_or(UsageSpeed::Standard),
        dedupe_key: Some(dedupe_key),
    })
}

// A skipped billed response still makes its delayed token_count context-only.
fn parse_usage_record(
    entry: &Value,
    payload: &Value,
    state: &mut CodexUsageState,
) -> Option<UsageLine> {
    let timestamp_ms = parse_timestamp_ms(&entry["timestamp"]);
    state.saw_usage_record = true;
    if timestamp_ms.is_some_and(|at| consume_fork_copy(state, at, payload["thread_id"].as_str())) {
        return None;
    }
    let turn = state
        .turn
        .as_ref()
        .filter(|turn| Some(turn.id.as_str()) == payload["turn_id"].as_str());
    let model = turn.map_or(state.model.as_str(), |turn| turn.model.as_str());
    let (Some(at), Some(usage), Some(id)) = (
        timestamp_ms,
        read_token_usage(&payload["usage"]),
        payload["response_id"].as_str().filter(|id| !id.is_empty()),
    ) else {
        return Some(UsageLine::Malformed(MalformedUsage { timestamp_ms }));
    };
    if model.is_empty() {
        return Some(UsageLine::Malformed(MalformedUsage { timestamp_ms }));
    }
    if usage.input_tokens + usage.output_tokens == 0.0 {
        return None;
    }
    let speed = if state.turn.is_some() {
        Some(
            turn.and_then(|turn| turn.speed)
                .unwrap_or(UsageSpeed::Unknown),
        )
    } else {
        state.thread_speed
    };
    Some(usage_record(
        &state.session_id,
        model,
        at,
        usage,
        speed,
        format!("codex-response:{id}"),
    ))
}

pub fn parse_codex_usage_line(line: &str, state: &mut CodexUsageState) -> Option<UsageLine> {
    let entry = match parse_first_jsonl_value(line) {
        JsonlLineResult::Value { value, .. } => value,
        JsonlLineResult::Invalid { .. } | JsonlLineResult::Incomplete => {
            return Some(UsageLine::Malformed(MalformedUsage { timestamp_ms: None }));
        }
        JsonlLineResult::Empty => return None,
    };
    let payload = &entry["payload"];
    if !payload.is_object() {
        return None;
    }

    match entry["type"].as_str() {
        Some("session_meta") => {
            if state.saw_session_meta {
                return None;
            }
            state.saw_session_meta = true;
            let id = &payload["id"];
            let session_id = if id.is_null() {
                &payload["session_id"]
            } else {
                id
            };
            if let Some(session_id) = session_id.as_str() {
                state.session_id = session_id.into();
            }
            let at = parse_timestamp_ms(&entry["timestamp"]);
            if at.is_some() && is_forked_session_meta(payload) {
                state.fork_thread_id = id
                    .as_str()
                    .filter(|id| native_thread_id(id))
                    .map(str::to_owned);
                state.fork_copy_anchor_ms = at.map(|at| Number(at as f64));
            }
            return None;
        }
        Some("token_usage_record") => return parse_usage_record(&entry, payload, state),
        Some("event_msg")
            if matches!(
                payload["type"].as_str(),
                Some("task_started" | "turn_started")
            ) =>
        {
            if let Some(id) = payload["turn_id"].as_str() {
                let model_changed = !state.model.is_empty()
                    && state
                        .thread_model
                        .as_ref()
                        .is_some_and(|model| !model.is_empty() && model != &state.model);
                state.turn = Some(UsageTurn {
                    id: id.into(),
                    model: if model_changed {
                        "unknown".into()
                    } else {
                        state.thread_model.as_ref().unwrap_or(&state.model).clone()
                    },
                    speed: state.thread_speed,
                    has_context: false,
                });
                return None;
            }
        }
        Some("turn_context") => {
            if let Some(model) = payload["model"].as_str() {
                state.model = model.into();
            }
            match payload["turn_id"].as_str() {
                None => state.turn = None,
                Some(id) => {
                    if let Some(turn) = state.turn.as_mut().filter(|turn| turn.id == id) {
                        turn.model.clone_from(&state.model);
                        turn.has_context = true;
                    } else {
                        state.turn = Some(UsageTurn {
                            id: id.into(),
                            model: state.model.clone(),
                            speed: state.thread_speed,
                            has_context: true,
                        });
                    }
                }
            }
            return None;
        }
        _ => {}
    }

    if payload["type"].as_str() == Some("thread_settings_applied") {
        let settings = &payload["thread_settings"];
        if settings.is_object() {
            if let Some(model) = settings["model"].as_str() {
                state.thread_model = Some(model.into());
            }
            state.thread_speed = Some(usage_speed_from_service_tier(&settings["service_tier"]));
            if let Some(turn) = state.turn.as_mut().filter(|turn| turn.speed.is_none()) {
                turn.speed = if turn.has_context {
                    state.thread_speed
                } else {
                    Some(UsageSpeed::Unknown)
                };
            }
        }
        return None;
    }
    let info = &payload["info"];
    if payload["type"].as_str() != Some("token_count") || !info.is_object() {
        return None;
    }
    let timestamp_ms =
        parse_timestamp_ms(&entry["timestamp"]).filter(|_| !state.model.is_empty())?;
    let last = read_token_usage(&info["last_token_usage"]);
    let raw_cumulative = &info["total_token_usage"];
    let has_cumulative = !raw_cumulative.is_null();
    let cumulative = read_token_usage(raw_cumulative);
    let previous = state.last_cumulative_usage;
    if let Some(cumulative) = cumulative {
        state.last_cumulative_usage = Some(cumulative);
    }

    if consume_fork_copy(state, timestamp_ms, None) {
        let signature = last.as_ref().map(CodexTokenUsage::signature);
        if let Some(last) = last
            && !has_cumulative
            && signature != state.last_usage_signature
        {
            state.last_cumulative_usage = combine_usage(previous, last, 1.0);
        }
        state.last_usage_signature = signature;
        return None;
    }
    if state.saw_usage_record {
        return None;
    }
    let malformed = Some(UsageLine::Malformed(MalformedUsage {
        timestamp_ms: Some(timestamp_ms),
    }));
    let Some(last) = last else { return malformed };
    if has_cumulative && cumulative.is_none() {
        return malformed;
    }
    if last.input_tokens + last.output_tokens == 0.0 {
        state.last_usage_signature = None;
        return None;
    }
    if cumulative.is_some() && cumulative == previous {
        return None;
    }
    if last.total_tokens != last.input_tokens + last.output_tokens {
        return malformed;
    }

    let signature = last.signature();
    if let Some(cumulative) = cumulative {
        let restarted = cumulative == last;
        let reconciled = match previous {
            None => combine_usage(Some(cumulative), last, -1.0).is_some(),
            Some(previous) => cumulative
                .fields()
                .into_iter()
                .zip(previous.fields())
                .zip(last.fields())
                .all(|((cumulative, previous), last)| cumulative - previous == last),
        };
        if !restarted && !reconciled {
            return malformed;
        }
    } else {
        if state.last_usage_signature.as_ref() == Some(&signature) {
            return None;
        }
        let Some(advanced) = combine_usage(previous, last, 1.0) else {
            return malformed;
        };
        state.last_cumulative_usage = Some(advanced);
    }
    let cumulative = cumulative
        .as_ref()
        .map_or_else(String::new, CodexTokenUsage::signature);
    // Verbatim forks keep the event time and counters under a new session ID.
    let dedupe_key = format!(
        "codex:{timestamp_ms}:{}:{signature}:{cumulative}",
        state.model
    );
    state.last_usage_signature = Some(signature);
    Some(usage_record(
        &state.session_id,
        &state.model,
        timestamp_ms,
        last,
        state.thread_speed,
        dedupe_key,
    ))
}

pub struct CodexUsageFormat;

impl TranscriptUsageFormat for CodexUsageFormat {
    type State = CodexUsageState;

    fn line_markers(&self) -> &[&str] {
        &[
            "\"token_usage_record\"",
            "\"token_count\"",
            "\"turn_context\"",
            "\"task_started\"",
            "\"turn_started\"",
            "\"thread_settings_applied\"",
            "\"session_meta\"",
        ]
    }

    fn create_state(&self) -> Self::State {
        create_codex_usage_state()
    }

    fn clone_state(&self, state: &Self::State) -> Self::State {
        state.clone()
    }

    fn parse_line(&self, line: &str, state: &mut Self::State) -> ExecutorResult<Option<UsageLine>> {
        Ok(parse_codex_usage_line(line, state))
    }
}
