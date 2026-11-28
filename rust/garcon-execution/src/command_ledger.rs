use std::{cell::RefCell, cmp::Ordering, rc::Rc};

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::{
    chat_command_contracts::SteerDeliveryOutcome, chat_stop::ChatStopOutcome,
    transcript_seed::NativeSeedReceipt,
};
use garcon_interface::{
    producer::AgentFinalResponse, resources::AgentResourceScope, transcript::AgentNativeSessionRef,
};
use garcon_js::{
    OptionalNullable,
    clock::{Clock, InvalidTimeValue, to_iso_string},
    is_safe_integer,
    json::{self, Opaque},
    utf16,
};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const LEDGER_RECORD_LIMIT: usize = 1000;
// Evicting a steering identity could redeliver an already delivered native steer.
pub const STEER_IDENTITY_LIMIT: usize = 10_000;
pub const TURN_RESULT_BYTE_LIMIT: usize = 4 * 1024 * 1024;
pub const TOTAL_TURN_RESULT_BYTE_LIMIT: usize = 64 * 1024 * 1024;
pub const PRE_SCHEDULE_FAILURE_ERROR_CODE: &str = "PRE_SCHEDULE_FAILED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandLedgerStatus {
    Accepted,
    Scheduled,
    Running,
    Finished,
    Failed,
    Rejected,
}

impl CommandLedgerStatus {
    fn terminal(self) -> bool {
        matches!(self, Self::Finished | Self::Failed | Self::Rejected)
    }

    fn unsuccessful(self) -> bool {
        matches!(self, Self::Failed | Self::Rejected)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandTerminalStatus {
    Finished,
    Failed,
}

impl From<CommandTerminalStatus> for CommandLedgerStatus {
    fn from(status: CommandTerminalStatus) -> Self {
        match status {
            CommandTerminalStatus::Finished => Self::Finished,
            CommandTerminalStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForkPreparationPhase {
    Creating,
    Created,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedAgentSession {
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub native_seed_receipt: Option<NativeSeedReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeForkCleanup {
    pub scope: AgentResourceScope,
    pub session: StartedAgentSession,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkPreparationState {
    pub phase: ForkPreparationPhase,
    pub source_chat_id: String,
    #[serde(
        default = "absent_native_cleanup",
        skip_serializing_if = "OptionalNullable::is_absent"
    )]
    pub native_cleanup: OptionalNullable<NativeForkCleanup>,
}

fn absent_native_cleanup() -> OptionalNullable<NativeForkCleanup> {
    OptionalNullable::ABSENT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InterruptionReason {
    UserStop,
    ChatDeleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableTurnResultReason {
    NoFinalResponse,
    TooLarge,
    RetentionPressure,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "availability", rename_all = "lowercase")]
pub enum CommandTurnResult {
    Available { text: String, bytes: usize },
    Unavailable { reason: UnavailableTurnResultReason },
}

impl CommandTurnResult {
    fn unavailable(reason: UnavailableTurnResultReason) -> Self {
        Self::Unavailable { reason }
    }
}

macro_rules! record_details {
    ($($variant:ident($ty:ty) => $getter:ident, $key:literal);+ $(;)?) => {
        #[derive(Debug, Clone, PartialEq)]
        pub enum CommandLedgerDetail {
            $($variant(Option<$ty>)),+
        }

        impl CommandLedgerDetail {
            fn serialize_entry<M: SerializeMap>(&self, map: &mut M) -> Result<(), M::Error> {
                match self {
                    $(Self::$variant(Some(value)) => map.serialize_entry($key, value),)+
                    _ => Ok(()),
                }
            }
        }

        impl CommandLedgerRecord {
            $(pub fn $getter(&self) -> Option<&$ty> {
                self.details.iter().find_map(|detail| match detail {
                    CommandLedgerDetail::$variant(value) => value.as_ref(),
                    _ => None,
                })
            })+
        }
    };
}

record_details! {
    Error(String) => error, "error";
    ErrorCode(String) => error_code, "errorCode";
    DeliveryOutcome(SteerDeliveryOutcome) => delivery_outcome, "deliveryOutcome";
    ForkPreparation(Box<ForkPreparationState>) => fork_preparation, "forkPreparation";
    StopOutcome(ChatStopOutcome) => stop_outcome, "stopOutcome";
    RunTerminalObserved(bool) => run_terminal_observed, "runTerminalObserved";
    TurnResult(CommandTurnResult) => turn_result, "turnResult";
    InterruptionReason(InterruptionReason) => interruption_reason, "interruptionReason";
    PublicTerminalAt(String) => public_terminal_at, "publicTerminalAt";
    RetainedPrivateTerminal(bool) => retained_private_terminal, "retainedPrivateTerminal";
    TerminalRetentionOrdinal(u64) => terminal_retention_ordinal, "terminalRetentionOrdinal";
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommandLedgerRecord {
    pub key: String,
    pub command_type: String,
    pub chat_id: String,
    pub client_request_id: String,
    pub payload_hash: String,
    pub payload: Opaque,
    pub status: CommandLedgerStatus,
    pub accepted_at: String,
    pub updated_at: String,
    pub turn_id: Option<String>,
    pub entry_id: Option<String>,
    // Updating a property preserves its insertion slot, even after setting it to undefined.
    details: Vec<CommandLedgerDetail>,
    payload_at_end: bool,
}

impl CommandLedgerRecord {
    fn set_detail(&mut self, detail: CommandLedgerDetail) {
        let key = std::mem::discriminant(&detail);
        if let Some(slot) = self
            .details
            .iter_mut()
            .find(|slot| std::mem::discriminant(*slot) == key)
        {
            *slot = detail;
        } else {
            self.details.push(detail);
        }
    }

    fn as_steer_tombstone(&self) -> Self {
        let mut result = self.clone();
        result.payload = empty_payload();
        result.payload_at_end = true;
        result.details.retain(|detail| {
            !matches!(
                detail,
                CommandLedgerDetail::ForkPreparation(_) | CommandLedgerDetail::StopOutcome(_)
            )
        });
        result
    }
}

impl Serialize for CommandLedgerRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("key", &self.key)?;
        map.serialize_entry("commandType", &self.command_type)?;
        map.serialize_entry("chatId", &self.chat_id)?;
        map.serialize_entry("clientRequestId", &self.client_request_id)?;
        map.serialize_entry("payloadHash", &self.payload_hash)?;
        if !self.payload_at_end {
            map.serialize_entry("payload", &self.payload)?;
        }
        map.serialize_entry("status", &self.status)?;
        map.serialize_entry("acceptedAt", &self.accepted_at)?;
        map.serialize_entry("updatedAt", &self.updated_at)?;
        if let Some(turn_id) = &self.turn_id {
            map.serialize_entry("turnId", turn_id)?;
        }
        if let Some(entry_id) = &self.entry_id {
            map.serialize_entry("entryId", entry_id)?;
        }
        for detail in &self.details {
            detail.serialize_entry(&mut map)?;
        }
        if self.payload_at_end {
            map.serialize_entry("payload", &self.payload)?;
        }
        map.end()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandLedgerChange {
    CommandType(String),
    ChatId(String),
    ClientRequestId(String),
    PayloadHash(String),
    Payload(Opaque),
    Status(CommandLedgerStatus),
    AcceptedAt(String),
    TurnId(Option<String>),
    EntryId(Option<String>),
    Detail(CommandLedgerDetail),
}

impl CommandLedgerChange {
    fn apply(self, record: &mut CommandLedgerRecord) {
        match self {
            Self::CommandType(value) => record.command_type = value,
            Self::ChatId(value) => record.chat_id = value,
            Self::ClientRequestId(value) => record.client_request_id = value,
            Self::PayloadHash(value) => record.payload_hash = value,
            Self::Payload(value) => record.payload = value,
            Self::Status(value) => record.status = value,
            Self::AcceptedAt(value) => record.accepted_at = value,
            Self::TurnId(value) => record.turn_id = value,
            Self::EntryId(value) => record.entry_id = value,
            Self::Detail(value) => record.set_detail(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAcceptInput {
    pub command_type: String,
    pub chat_id: String,
    pub client_request_id: String,
    pub payload: Opaque,
    pub turn_id: Option<String>,
    pub entry_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LedgerAcceptResult {
    Accepted { record: CommandLedgerRecord },
    Duplicate { record: CommandLedgerRecord },
    Conflict { record: CommandLedgerRecord },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CommandTerminalResult {
    Applied { record: CommandLedgerRecord },
    Duplicate { record: CommandLedgerRecord },
    Conflict { record: CommandLedgerRecord },
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandLedgerOptions {
    pub steer_identity_limit: Option<f64>,
    pub record_limit: Option<f64>,
    pub turn_result_byte_limit: Option<f64>,
    pub total_turn_result_byte_limit: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
#[error("The process-lifetime steering identity capacity is exhausted")]
pub struct SteerIdentityCapacityError;

impl DiagnosticError for SteerIdentityCapacityError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "SteerIdentityCapacityError",
            code: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CommandLedgerError {
    #[error("steerIdentityLimit must be a positive safe integer")]
    InvalidSteerIdentityLimit,
    #[error("Command ledger identity index is stale for {0}")]
    StaleIdentityIndex(String),
    #[error("Turn {0} already has an immutable receipt owner")]
    TurnAlreadyOwned(String),
    #[error(transparent)]
    SteerIdentityCapacity(#[from] SteerIdentityCapacityError),
    #[error(transparent)]
    InvalidTime(#[from] InvalidTimeValue),
}

impl DiagnosticError for CommandLedgerError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        match self {
            Self::SteerIdentityCapacity(error) => error.diagnostic_metadata(),
            Self::InvalidTime(_) => ErrorMetadata {
                name: "RangeError",
                code: None,
            },
            _ => ErrorMetadata {
                name: "Error",
                code: None,
            },
        }
    }
}

fn stable_stringify(value: &Value, out: &mut String) {
    match value {
        Value::Array(elements) => {
            out.push('[');
            for (index, element) in elements.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                stable_stringify(element, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            let mut fields: Vec<_> = object.iter().collect();
            fields.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, (key, value)) in fields.into_iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                out.push_str(&json::stringify(&Value::String(key.clone())));
                out.push(':');
                stable_stringify(value, out);
            }
            out.push('}');
        }
        other => out.push_str(&json::stringify(other)),
    }
}

fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn compact_attachment(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let Some(data) = object.get("data").and_then(Value::as_str) else {
        return value.clone();
    };
    let mut compact: Map<_, _> = object
        .iter()
        .filter(|(key, _)| key.as_str() != "data")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    compact.insert("dataSha256".into(), Value::String(sha256(data)));
    compact.insert("dataLength".into(), Value::from(utf16::len(data)));
    Value::Object(compact)
}

fn compact_payload_value(value: &Value, key: Option<&str>) -> Value {
    match value {
        Value::Array(elements) if key == Some("images") => {
            Value::Array(elements.iter().map(compact_attachment).collect())
        }
        Value::Array(elements) => Value::Array(
            elements
                .iter()
                .map(|item| compact_payload_value(item, None))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), compact_payload_value(value, Some(key))))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn compact_command_payload(payload: &Opaque) -> Opaque {
    Opaque::from_value(compact_payload_value(payload.as_value(), None))
}

pub fn command_payload_hash(payload: &Opaque) -> String {
    let mut text = String::new();
    stable_stringify(&compact_command_payload(payload), &mut text);
    sha256(&text)
}

pub fn command_ledger_key(command_type: &str, chat_id: &str, client_request_id: &str) -> String {
    format!("{command_type}:{chat_id}:{client_request_id}")
}

fn turn_index_key(chat_id: &str, turn_id: &str) -> String {
    format!("{chat_id}:{turn_id}")
}

fn empty_payload() -> Opaque {
    Opaque::from_value(Value::Object(Map::new()))
}

type LiveRecord = Rc<RefCell<CommandLedgerRecord>>;
type RequestIdentity = (String, String);

struct Waiter {
    signal: CancellationToken,
    done: oneshot::Sender<Option<CommandLedgerRecord>>,
}

#[derive(Default)]
struct LedgerState {
    records: IndexMap<String, (u64, LiveRecord)>,
    next_insertion: u64,
    steer_tombstones: IndexMap<String, CommandLedgerRecord>,
    keys_by_identity: IndexMap<RequestIdentity, String>,
    steer_identity_count: usize,
    turn_owner_index: IndexMap<String, String>,
    terminal_waiters: IndexMap<String, IndexMap<u64, Waiter>>,
    next_waiter: u64,
    pending_chat_deletions: IndexSet<String>,
    result_bytes: f64,
    next_terminal_retention_ordinal: u64,
}

struct WaitRegistration<'a> {
    state: &'a RefCell<LedgerState>,
    key: String,
    id: u64,
}

impl Drop for WaitRegistration<'_> {
    fn drop(&mut self) {
        let mut state = self.state.borrow_mut();
        if let Some(waiters) = state.terminal_waiters.get_mut(&self.key) {
            waiters.shift_remove(&self.id);
            if waiters.is_empty() {
                state.terminal_waiters.shift_remove(&self.key);
            }
        }
    }
}

pub struct CommandLedger {
    state: RefCell<LedgerState>,
    clock: Rc<dyn Clock>,
    steer_identity_limit: u64,
    record_limit: f64,
    turn_result_byte_limit: f64,
    total_turn_result_byte_limit: f64,
}

impl CommandLedger {
    pub fn new(
        options: CommandLedgerOptions,
        clock: Rc<dyn Clock>,
    ) -> Result<Self, CommandLedgerError> {
        let steer_identity_limit = options
            .steer_identity_limit
            .unwrap_or(STEER_IDENTITY_LIMIT as f64);
        if !is_safe_integer(steer_identity_limit) || steer_identity_limit < 1.0 {
            return Err(CommandLedgerError::InvalidSteerIdentityLimit);
        }
        Ok(Self {
            state: RefCell::default(),
            clock,
            steer_identity_limit: steer_identity_limit as u64,
            record_limit: options.record_limit.unwrap_or(LEDGER_RECORD_LIMIT as f64),
            turn_result_byte_limit: options
                .turn_result_byte_limit
                .unwrap_or(TURN_RESULT_BYTE_LIMIT as f64),
            total_turn_result_byte_limit: options
                .total_turn_result_byte_limit
                .unwrap_or(TOTAL_TURN_RESULT_BYTE_LIMIT as f64),
        })
    }

    fn now(&self) -> Result<String, InvalidTimeValue> {
        to_iso_string(self.clock.now_ms())
    }

    pub async fn get_record(&self, key: &str) -> Option<CommandLedgerRecord> {
        self.state.borrow().record_or_tombstone(key)
    }

    pub async fn get_turn_record(
        &self,
        chat_id: &str,
        turn_id: &str,
    ) -> Option<CommandLedgerRecord> {
        self.state
            .borrow()
            .record_for_turn(chat_id, turn_id)
            .map(|record| record.borrow().clone())
    }

    pub async fn wait_for_turn_terminal<E>(
        &self,
        chat_id: &str,
        turn_id: &str,
        signal: &CancellationToken,
        abort_reason: impl FnOnce() -> E,
    ) -> Result<Option<CommandLedgerRecord>, E> {
        if signal.is_cancelled() {
            return Err(abort_reason());
        }
        let key = turn_index_key(chat_id, turn_id);
        let (registration, mut received) = {
            let mut state = self.state.borrow_mut();
            let Some(record) = state.record_for_turn(chat_id, turn_id) else {
                return Ok(None);
            };
            let record = record.borrow();
            if record.retained_private_terminal() == Some(&true) {
                return Ok(None);
            }
            if record.public_terminal_at().is_some_and(|at| !at.is_empty()) {
                return Ok(Some(record.clone()));
            }
            let (done, received) = oneshot::channel();
            state.next_waiter += 1;
            let id = state.next_waiter;
            state
                .terminal_waiters
                .entry(key.clone())
                .or_default()
                .insert(
                    id,
                    Waiter {
                        signal: signal.clone(),
                        done,
                    },
                );
            (
                WaitRegistration {
                    state: &self.state,
                    key,
                    id,
                },
                received,
            )
        };
        let result = tokio::select! {
            biased;
            result = &mut received => match result {
                Ok(record) => Ok(record),
                Err(_) => Err(abort_reason()),
            },
            () = signal.cancelled() => Err(abort_reason()),
        };
        drop(registration);
        result
    }

    pub async fn set_turn_result(
        &self,
        chat_id: &str,
        turn_id: &str,
        response: Option<&AgentFinalResponse>,
    ) -> Result<Option<CommandLedgerRecord>, CommandLedgerError> {
        use UnavailableTurnResultReason::{NoFinalResponse, RetentionPressure, TooLarge};
        let mut state = self.state.borrow_mut();
        let Some(live) = state.record_for_turn(chat_id, turn_id) else {
            return Ok(None);
        };
        let mut record = live.borrow_mut();
        if record.public_terminal_at().is_some_and(|at| !at.is_empty()) {
            return Ok(Some(record.clone()));
        }
        record.set_detail(CommandLedgerDetail::RunTerminalObserved(Some(true)));
        if record.turn_result().is_some() {
            return Ok(Some(record.clone()));
        }
        let result = match response {
            Some(AgentFinalResponse::Text { text } | AgentFinalResponse::LiteralText { text })
                if record.interruption_reason().is_none() && !record.status.unsuccessful() =>
            {
                let bytes = text.len();
                if bytes as f64 > self.turn_result_byte_limit {
                    CommandTurnResult::unavailable(TooLarge)
                } else {
                    // This record is not public, so it cannot be a candidate.
                    drop(record);
                    state.expire_terminal_results(bytes, self.total_turn_result_byte_limit);
                    let result =
                        if state.result_bytes + bytes as f64 > self.total_turn_result_byte_limit {
                            CommandTurnResult::unavailable(RetentionPressure)
                        } else {
                            state.result_bytes += bytes as f64;
                            CommandTurnResult::Available {
                                text: text.clone(),
                                bytes,
                            }
                        };
                    let mut current = live.borrow_mut();
                    current.set_detail(CommandLedgerDetail::TurnResult(Some(result)));
                    current.updated_at = self.now()?;
                    return Ok(Some(current.clone()));
                }
            }
            _ => CommandTurnResult::unavailable(NoFinalResponse),
        };
        record.set_detail(CommandLedgerDetail::TurnResult(Some(result)));
        record.updated_at = self.now()?;
        Ok(Some(record.clone()))
    }

    pub async fn mark_interrupted_without_run_terminal(
        &self,
        chat_id: &str,
        turn_id: &str,
        reason: InterruptionReason,
    ) -> Result<Option<CommandLedgerRecord>, CommandLedgerError> {
        if let Some(record) = self.state.borrow().record_for_turn(chat_id, turn_id)
            && record.borrow().run_terminal_observed() == Some(&true)
        {
            return Ok(Some(record.borrow().clone()));
        }
        self.mark_public_terminal(chat_id, turn_id, Some(reason))
            .await
    }

    pub async fn mark_public_terminal(
        &self,
        chat_id: &str,
        turn_id: &str,
        interruption_reason: Option<InterruptionReason>,
    ) -> Result<Option<CommandLedgerRecord>, CommandLedgerError> {
        let mut state = self.state.borrow_mut();
        let Some(live) = state.record_for_turn(chat_id, turn_id) else {
            return Ok(None);
        };
        {
            let mut record = live.borrow_mut();
            if record.public_terminal_at().is_some_and(|at| !at.is_empty())
                || record.retained_private_terminal() == Some(&true)
            {
                return Ok(Some(record.clone()));
            }
            if let Some(reason) = interruption_reason {
                record.set_detail(CommandLedgerDetail::InterruptionReason(Some(reason)));
                record.status = CommandLedgerStatus::Finished;
            }
            state.clear_unsuccessful_result(&mut record);
            if record.turn_result().is_none() {
                record.set_detail(CommandLedgerDetail::TurnResult(Some(
                    CommandTurnResult::unavailable(UnavailableTurnResultReason::NoFinalResponse),
                )));
            }
            if state.pending_chat_deletions.contains(chat_id) {
                return Ok(Some(record.clone()));
            }
            let now = self.now()?;
            record.set_detail(CommandLedgerDetail::PublicTerminalAt(Some(now.clone())));
            record.updated_at = now;
            record.payload = empty_payload();
            state.assign_terminal_retention_ordinal(&mut record);
            state.notify_terminal_waiters(&record);
        }
        state.expire_terminal_results(0, self.total_turn_result_byte_limit);
        state.trim_records(self.record_limit);
        Ok(Some(live.borrow().clone()))
    }

    pub fn begin_chat_deletion(&self, chat_id: &str) {
        self.state
            .borrow_mut()
            .pending_chat_deletions
            .insert(chat_id.to_owned());
    }

    pub async fn cancel_chat_deletion(&self, chat_id: &str) -> Result<(), CommandLedgerError> {
        if !self
            .state
            .borrow_mut()
            .pending_chat_deletions
            .shift_remove(chat_id)
        {
            return Ok(());
        }
        let mut cursor = 0;
        loop {
            let live = self.state.borrow().next_record(&mut cursor);
            let Some(live) = live else {
                return Ok(());
            };
            let (turn_id, reason) = {
                let mut record = live.borrow_mut();
                let Some(turn_id) = unpublished_turn(&record, chat_id).map(str::to_owned) else {
                    continue;
                };
                if record.interruption_reason() == Some(&InterruptionReason::ChatDeleted) {
                    record.set_detail(CommandLedgerDetail::InterruptionReason(Some(
                        InterruptionReason::UserStop,
                    )));
                }
                if !record.status.terminal() {
                    continue;
                }
                (turn_id, record.interruption_reason().copied())
            };
            self.mark_public_terminal(chat_id, &turn_id, reason).await?;
            tokio::task::yield_now().await;
        }
    }

    pub async fn mark_chat_interrupted(&self, chat_id: &str) -> Result<(), CommandLedgerError> {
        self.state
            .borrow_mut()
            .pending_chat_deletions
            .shift_remove(chat_id);
        let mut cursor = 0;
        loop {
            let live = self.state.borrow().next_record(&mut cursor);
            let Some(live) = live else {
                return Ok(());
            };
            let turn_id = unpublished_turn(&live.borrow(), chat_id).map(str::to_owned);
            if let Some(turn_id) = turn_id {
                self.mark_public_terminal(chat_id, &turn_id, Some(InterruptionReason::ChatDeleted))
                    .await?;
                tokio::task::yield_now().await;
            }
        }
    }

    pub fn unsettled_queue_receipt_keys(&self, chat_id: &str) -> IndexSet<String> {
        self.state
            .borrow()
            .records
            .values()
            .filter_map(|(_, live)| {
                let record = live.borrow();
                if record.chat_id == chat_id
                    && matches!(
                        record.command_type.as_str(),
                        "queue-entry-create"
                            | "queue-entry-replace"
                            | "queue-entry-delete"
                            | "queue-entry-move"
                    )
                    && !record.status.terminal()
                {
                    Some(record.key.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    pub async fn observe(
        &self,
        input: &LedgerAcceptInput,
    ) -> Result<Option<LedgerAcceptResult>, CommandLedgerError> {
        let key = command_ledger_key(
            &input.command_type,
            &input.chat_id,
            &input.client_request_id,
        );
        let payload_hash = command_payload_hash(&input.payload);
        let state = self.state.borrow();
        if let Some(record) = state.record_or_tombstone(&key) {
            return Ok(Some(compare_payload(record, &payload_hash)));
        }
        state.conflicting_identity(input)
    }

    pub async fn accept(
        &self,
        input: &LedgerAcceptInput,
    ) -> Result<LedgerAcceptResult, CommandLedgerError> {
        let key = command_ledger_key(
            &input.command_type,
            &input.chat_id,
            &input.client_request_id,
        );
        let payload_hash = command_payload_hash(&input.payload);
        let mut state = self.state.borrow_mut();
        if let Some(existing) = state.live_record(&key) {
            let mut record = existing.borrow().clone();
            if record.payload_hash == payload_hash
                && record.status == CommandLedgerStatus::Failed
                && record
                    .error_code()
                    .is_some_and(|code| code == PRE_SCHEDULE_FAILURE_ERROR_CODE)
            {
                state.remove_turn_index(&record);
                state.discard_result(&mut existing.borrow_mut());
                let now = self.now()?;
                record.payload = compact_command_payload(&input.payload);
                record.status = CommandLedgerStatus::Accepted;
                record.accepted_at = now.clone();
                record.updated_at = now;
                record.turn_id.clone_from(&input.turn_id);
                record.entry_id.clone_from(&input.entry_id);
                use CommandLedgerDetail as D;
                for detail in [
                    D::Error(None),
                    D::ErrorCode(None),
                    D::DeliveryOutcome(None),
                    D::ForkPreparation(None),
                    D::RunTerminalObserved(None),
                    D::TurnResult(None),
                    D::InterruptionReason(None),
                    D::PublicTerminalAt(None),
                    D::RetainedPrivateTerminal(None),
                    D::TerminalRetentionOrdinal(None),
                ] {
                    record.set_detail(detail);
                }
                state.set_record(&key, record.clone());
                state.index_turn(&record)?;
                return Ok(LedgerAcceptResult::Accepted { record });
            }
            return Ok(compare_payload(record, &payload_hash));
        }
        if let Some(record) = state.steer_tombstones.get(&key) {
            return Ok(compare_payload(record.clone(), &payload_hash));
        }
        if let Some(conflict) = state.conflicting_identity(input)? {
            return Ok(conflict);
        }
        if input.command_type == "steer"
            && state.steer_identity_count as u64 >= self.steer_identity_limit
        {
            return Err(SteerIdentityCapacityError.into());
        }
        let now = self.now()?;
        let record = CommandLedgerRecord {
            key: key.clone(),
            command_type: input.command_type.clone(),
            chat_id: input.chat_id.clone(),
            client_request_id: input.client_request_id.clone(),
            payload_hash,
            payload: compact_command_payload(&input.payload),
            status: CommandLedgerStatus::Accepted,
            accepted_at: now.clone(),
            updated_at: now,
            turn_id: input.turn_id.clone(),
            entry_id: input.entry_id.clone(),
            details: Vec::new(),
            payload_at_end: false,
        };
        state.assert_turn_owner_available(&record)?;
        let live = state.set_record(&key, record);
        {
            let record = live.borrow();
            state
                .keys_by_identity
                .insert(identity(&record.chat_id, &record.client_request_id), key);
            if record.command_type == "steer" {
                state.steer_identity_count += 1;
            }
            state.index_turn(&record)?;
        }
        state.trim_records(self.record_limit);
        Ok(LedgerAcceptResult::Accepted {
            record: live.borrow().clone(),
        })
    }

    pub async fn update(
        &self,
        key: &str,
        patch: impl IntoIterator<Item = CommandLedgerChange>,
    ) -> Result<Option<CommandLedgerRecord>, CommandLedgerError> {
        let mut state = self.state.borrow_mut();
        let Some(existing) = state.live_record(key) else {
            return Ok(None);
        };
        let mut next = existing.borrow().clone();
        for change in patch {
            change.apply(&mut next);
        }
        next.updated_at = self.now()?;
        let live = Self::replace_record(&mut state, key, next, self.record_limit);
        Ok(Some(live.borrow().clone()))
    }

    pub async fn update_unless_status(
        &self,
        key: &str,
        blocked_statuses: &[CommandLedgerStatus],
        patch: impl IntoIterator<Item = CommandLedgerChange>,
    ) -> Result<Option<CommandLedgerRecord>, CommandLedgerError> {
        {
            let Some(existing) = self.state.borrow().live_record(key) else {
                return Ok(None);
            };
            let existing = existing.borrow();
            if blocked_statuses.contains(&existing.status) {
                return Ok(Some(existing.clone()));
            }
        }
        self.update(key, patch).await
    }

    pub async fn settle_terminal(
        &self,
        key: &str,
        status: CommandTerminalStatus,
        patch: impl IntoIterator<Item = CommandLedgerChange>,
    ) -> Result<Option<CommandTerminalResult>, CommandLedgerError> {
        let status = status.into();
        let mut state = self.state.borrow_mut();
        let Some(existing) = state.live_record(key) else {
            return Ok(None);
        };
        let mut next = existing.borrow().clone();
        if next.status.terminal() {
            return Ok(Some(if next.status == status {
                CommandTerminalResult::Duplicate { record: next }
            } else {
                CommandTerminalResult::Conflict { record: next }
            }));
        }
        for change in patch {
            change.apply(&mut next);
        }
        next.status = status;
        next.updated_at = self.now()?;
        next.payload = empty_payload();
        let live = Self::replace_record(&mut state, key, next, self.record_limit);
        Ok(Some(CommandTerminalResult::Applied {
            record: live.borrow().clone(),
        }))
    }

    fn replace_record(
        state: &mut LedgerState,
        key: &str,
        mut record: CommandLedgerRecord,
        record_limit: f64,
    ) -> LiveRecord {
        state.clear_unsuccessful_result(&mut record);
        state.assign_terminal_retention_ordinal(&mut record);
        let live = state.set_record(key, record);
        state.notify_terminal_waiters(&live.borrow());
        state.trim_records(record_limit);
        live
    }
}

fn compare_payload(record: CommandLedgerRecord, payload_hash: &str) -> LedgerAcceptResult {
    if record.payload_hash == payload_hash {
        LedgerAcceptResult::Duplicate { record }
    } else {
        LedgerAcceptResult::Conflict { record }
    }
}

fn identity(chat_id: &str, client_request_id: &str) -> RequestIdentity {
    (chat_id.into(), client_request_id.into())
}

fn unpublished_turn<'a>(record: &'a CommandLedgerRecord, chat_id: &str) -> Option<&'a str> {
    (record.chat_id == chat_id && record.public_terminal_at().is_none_or(String::is_empty))
        .then_some(record.turn_id.as_deref())
        .flatten()
        .filter(|turn| !turn.is_empty())
}

impl LedgerState {
    fn live_record(&self, key: &str) -> Option<LiveRecord> {
        self.records.get(key).map(|(_, record)| Rc::clone(record))
    }

    fn set_record(&mut self, key: &str, record: CommandLedgerRecord) -> LiveRecord {
        let live = Rc::new(RefCell::new(record));
        if let Some((_, slot)) = self.records.get_mut(key) {
            *slot = Rc::clone(&live);
        } else {
            self.next_insertion += 1;
            self.records
                .insert(key.into(), (self.next_insertion, Rc::clone(&live)));
        }
        live
    }

    fn next_record(&self, cursor: &mut u64) -> Option<LiveRecord> {
        // Map iteration sees new insertions after an await, but skips removed records.
        let i = self
            .records
            .as_slice()
            .partition_point(|_, (ordinal, _)| ordinal <= cursor);
        let (_, (ordinal, record)) = self.records.get_index(i)?;
        *cursor = *ordinal;
        Some(Rc::clone(record))
    }

    fn record_or_tombstone(&self, key: &str) -> Option<CommandLedgerRecord> {
        self.live_record(key)
            .map(|record| record.borrow().clone())
            .or_else(|| self.steer_tombstones.get(key).cloned())
    }

    fn conflicting_identity(
        &self,
        input: &LedgerAcceptInput,
    ) -> Result<Option<LedgerAcceptResult>, CommandLedgerError> {
        let Some(key) = self
            .keys_by_identity
            .get(&identity(&input.chat_id, &input.client_request_id))
        else {
            return Ok(None);
        };
        let record = self
            .record_or_tombstone(key)
            .ok_or_else(|| CommandLedgerError::StaleIdentityIndex(key.clone()))?;
        Ok(Some(LedgerAcceptResult::Conflict { record }))
    }

    fn record_for_turn(&self, chat_id: &str, turn_id: &str) -> Option<LiveRecord> {
        let key = self
            .turn_owner_index
            .get(&turn_index_key(chat_id, turn_id))?;
        self.live_record(key)
    }

    fn assert_turn_owner_available(
        &self,
        record: &CommandLedgerRecord,
    ) -> Result<(), CommandLedgerError> {
        if let Some(turn_id) = record.turn_id.as_deref().filter(|turn| !turn.is_empty())
            && record.command_type != "steer"
            && self
                .turn_owner_index
                .get(&turn_index_key(&record.chat_id, turn_id))
                .is_some_and(|owner| owner != &record.key)
        {
            return Err(CommandLedgerError::TurnAlreadyOwned(turn_id.into()));
        }
        Ok(())
    }

    fn index_turn(&mut self, record: &CommandLedgerRecord) -> Result<(), CommandLedgerError> {
        self.assert_turn_owner_available(record)?;
        if let Some(turn_id) = record.turn_id.as_deref().filter(|turn| !turn.is_empty())
            && record.command_type != "steer"
        {
            self.turn_owner_index
                .insert(turn_index_key(&record.chat_id, turn_id), record.key.clone());
        }
        Ok(())
    }

    fn remove_turn_index(&mut self, record: &CommandLedgerRecord) {
        let Some(turn_id) = record.turn_id.as_deref().filter(|turn| !turn.is_empty()) else {
            return;
        };
        let key = turn_index_key(&record.chat_id, turn_id);
        if self.turn_owner_index.get(&key) == Some(&record.key) {
            self.turn_owner_index.shift_remove(&key);
            self.complete_waiters(&key, None);
        }
    }

    fn notify_terminal_waiters(&mut self, record: &CommandLedgerRecord) {
        let private = record.retained_private_terminal() == Some(&true);
        let public = record.public_terminal_at().is_some_and(|at| !at.is_empty());
        let Some(turn_id) = record.turn_id.as_deref().filter(|turn| !turn.is_empty()) else {
            return;
        };
        if !public && !private {
            return;
        }
        let key = turn_index_key(&record.chat_id, turn_id);
        if self.turn_owner_index.get(&key) == Some(&record.key) {
            self.complete_waiters(&key, (!private).then_some(record));
        }
    }

    fn complete_waiters(&mut self, key: &str, record: Option<&CommandLedgerRecord>) {
        if let Some(waiters) = self.terminal_waiters.shift_remove(key) {
            for waiter in waiters.into_values() {
                if !waiter.signal.is_cancelled() {
                    let _ = waiter.done.send(record.cloned());
                }
            }
        }
    }

    fn clear_unsuccessful_result(&mut self, record: &mut CommandLedgerRecord) {
        if record.interruption_reason().is_some() || record.status.unsuccessful() {
            self.discard_result(record);
            record.set_detail(CommandLedgerDetail::TurnResult(Some(
                CommandTurnResult::unavailable(UnavailableTurnResultReason::NoFinalResponse),
            )));
        }
    }

    fn discard_result(&mut self, record: &mut CommandLedgerRecord) {
        if let Some(CommandTurnResult::Available { bytes, .. }) = record.turn_result() {
            self.result_bytes -= *bytes as f64;
        }
        record.set_detail(CommandLedgerDetail::TurnResult(None));
    }

    fn assign_terminal_retention_ordinal(&mut self, record: &mut CommandLedgerRecord) {
        if record.terminal_retention_ordinal().is_some() || !record.status.terminal() {
            return;
        }
        if record.turn_id.as_ref().is_some_and(|id| !id.is_empty())
            && record.public_terminal_at().is_none_or(String::is_empty)
            && record.retained_private_terminal() != Some(&true)
        {
            return;
        }
        self.next_terminal_retention_ordinal += 1;
        record.set_detail(CommandLedgerDetail::TerminalRetentionOrdinal(Some(
            self.next_terminal_retention_ordinal,
        )));
    }

    fn trim_records(&mut self, record_limit: f64) {
        let mut evictable: Vec<_> = self
            .records
            .iter()
            .filter_map(|(key, (_, record))| {
                let record = record.borrow();
                let ordinal = record.terminal_retention_ordinal()?;
                (record.status.terminal() && record.fork_preparation().is_none())
                    .then(|| (*ordinal, key.clone()))
            })
            .collect();
        evictable.sort_by_key(|(ordinal, _)| *ordinal);
        let mut remaining = evictable.len();
        for (_, key) in evictable {
            if (remaining as f64).partial_cmp(&record_limit) != Some(Ordering::Greater) {
                break;
            }
            remaining -= 1;
            if let Some((_, live)) = self.records.shift_remove(&key) {
                let mut record = live.borrow_mut();
                if record.command_type == "steer" {
                    self.steer_tombstones
                        .insert(key, record.as_steer_tombstone());
                } else {
                    self.keys_by_identity
                        .shift_remove(&identity(&record.chat_id, &record.client_request_id));
                }
                self.remove_turn_index(&record);
                self.discard_result(&mut record);
            }
        }
    }

    fn expire_terminal_results(&mut self, required_bytes: usize, byte_limit: f64) {
        while self.result_bytes + required_bytes as f64 > byte_limit {
            let oldest = self
                .records
                .values()
                .filter_map(|(_, record)| {
                    let candidate = record.borrow();
                    let ordinal = candidate.terminal_retention_ordinal()?;
                    let CommandTurnResult::Available { bytes, .. } = candidate.turn_result()?
                    else {
                        return None;
                    };
                    (candidate.public_terminal_at().is_some() && *bytes > 0)
                        .then_some((*ordinal, record))
                })
                .min_by_key(|(ordinal, _)| *ordinal)
                .map(|(_, record)| Rc::clone(record));
            let Some(oldest) = oldest else {
                return;
            };
            let mut oldest = oldest.borrow_mut();
            self.discard_result(&mut oldest);
            oldest.set_detail(CommandLedgerDetail::TurnResult(Some(
                CommandTurnResult::unavailable(UnavailableTurnResultReason::Expired),
            )));
        }
    }
}
