//! The current ownership journal. Accepted objects are kept in their stored
//! wire order so an unrelated intent update does not reshape them.

use std::rc::Rc;

use garcon_contract::{
    agent_integration::{AgentSettingsEnvelope, parse_agent_settings_envelope},
    api_providers::ApiProtocol,
    chat_modes::{PermissionMode, ThinkingMode, is_permission_mode, is_thinking_mode},
    executors::{ExecutorId, parse_executor_id},
    transcript_seed::parse_native_seed_receipt,
};
use garcon_interface::transcript::{AgentChatReference, AgentNativeSessionRef};
use garcon_js::{
    OptionalNullable, is_safe_integer,
    json::{Opaque, as_number},
};
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::{Map, Value, json};

pub const AGENT_OWNERSHIP_JOURNAL_VERSION: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffPhase {
    CommitDecided,
    RegistryCommitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeletePhase {
    Prepared,
    RegistryRemoved,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSource {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub agent_id: String,
    pub agent_ownership_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgentHandoffTarget {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub agent_id: String,
    pub model: String,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub model_protocol: Option<ApiProtocol>,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings: AgentSettingsEnvelope,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffTarget {
    pub execution: ResolvedAgentHandoffTarget,
    pub agent_ownership_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWatermark {
    pub view_id: String,
    pub ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandoffIntent {
    pub(crate) version: u64,
    pub operation_id: String,
    pub client_request_id: String,
    pub submitted_target_hash: String,
    pub(crate) kind: &'static str,
    pub chat_id: String,
    pub phase: HandoffPhase,
    pub source: HandoffSource,
    pub target: HandoffTarget,
    pub watermark: TranscriptWatermark,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteIntent {
    pub version: u64,
    pub operation_id: String,
    pub kind: &'static str,
    pub chat_id: String,
    pub phase: DeletePhase,
    pub source_epoch: Option<String>,
    #[serde(serialize_with = "serialize_shared")]
    pub release_references: Vec<Rc<ReleaseReference>>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ReleaseReference {
    pub executor_id: OptionalNullable<ExecutorId>,
    pub chat: AgentChatReference,
    wire: Opaque,
}

impl Serialize for ReleaseReference {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.wire.serialize(serializer)
    }
}

impl ReleaseReference {
    pub(crate) fn from_chat(
        chat: AgentChatReference,
        executor_id: OptionalNullable<ExecutorId>,
        connected: bool,
    ) -> Result<Self, serde_json::Error> {
        let mut wire = if connected {
            serde_json::to_value(&chat)?
        } else {
            // The directory-unavailable fallback produces a different literal order.
            json!({
                "chatId": chat.chat_id, "agentId": chat.agent_id, "agentSessionId": chat.agent_session_id,
                "nativeSession": chat.native_session, "nativeSeedReceipt": chat.native_seed_receipt,
                "projectPath": chat.project_path, "model": chat.model, "settings": chat.settings,
                "carryOverRevision": chat.carry_over_revision,
            })
        };
        let executor_id = omit_empty_executor(executor_id);
        if let Some(id) = executor_id.as_option() {
            wire["executorId"] = Value::String(id.clone());
        }
        Ok(Self {
            executor_id,
            chat,
            wire: Opaque::from_value(wire),
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) enum OwnershipIntent {
    Handoff(Box<AgentHandoffIntent>),
    Delete(DeleteIntent),
}

impl OwnershipIntent {
    pub fn operation_id(&self) -> &str {
        match self {
            Self::Handoff(intent) => &intent.operation_id,
            Self::Delete(intent) => &intent.operation_id,
        }
    }

    pub fn chat_id(&self) -> &str {
        match self {
            Self::Handoff(intent) => &intent.chat_id,
            Self::Delete(intent) => &intent.chat_id,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StoredIntent {
    pub value: OwnershipIntent,
    wire: Opaque,
}

impl StoredIntent {
    pub fn handoff(intent: AgentHandoffIntent) -> Result<Self, serde_json::Error> {
        let wire = Opaque::from_value(serde_json::to_value(&intent)?);
        Ok(Self {
            value: OwnershipIntent::Handoff(Box::new(intent)),
            wire,
        })
    }

    pub fn delete(intent: DeleteIntent) -> Result<Self, serde_json::Error> {
        let wire = Opaque::from_value(serde_json::to_value(&intent)?);
        Ok(Self {
            value: OwnershipIntent::Delete(intent),
            wire,
        })
    }

    pub fn target_execution_wire(&self) -> &Value {
        &self.wire["target"]["execution"]
    }

    pub fn commit_handoff(&self, mut intent: AgentHandoffIntent) -> Self {
        intent.phase = HandoffPhase::RegistryCommitted;
        let mut wire = (*self.wire).clone();
        wire["phase"] = Value::String("registry-committed".into());
        Self {
            value: OwnershipIntent::Handoff(Box::new(intent)),
            wire: Opaque::from_value(wire),
        }
    }

    pub fn mark_registry_removed(&self, mut intent: DeleteIntent) -> Self {
        intent.phase = DeletePhase::RegistryRemoved;
        let mut wire = (*self.wire).clone();
        wire["phase"] = Value::String("registry-removed".into());
        Self {
            value: OwnershipIntent::Delete(intent),
            wire: Opaque::from_value(wire),
        }
    }

    pub fn with_remaining(
        &self,
        mut intent: DeleteIntent,
        remaining: Vec<Rc<ReleaseReference>>,
    ) -> Self {
        let mut wire = (*self.wire).clone();
        wire["releaseReferences"] = Value::Array(
            remaining
                .iter()
                .map(|entry| (*entry.wire).clone())
                .collect(),
        );
        intent.release_references = remaining;
        Self {
            value: OwnershipIntent::Delete(intent),
            wire: Opaque::from_value(wire),
        }
    }
}

impl Serialize for StoredIntent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.wire.serialize(serializer)
    }
}

#[derive(Debug, Clone)]
pub struct AgentOwnershipJournalFileV5 {
    root: Rc<Opaque>,
    pub(crate) intents: Vec<Rc<StoredIntent>>,
}

impl Serialize for AgentOwnershipJournalFileV5 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut entries = serializer.serialize_map(None)?;
        for (key, value) in self.root.as_object().into_iter().flatten() {
            if key == "ownershipIntents" {
                entries.serialize_entry(key, &Shared(&self.intents))?;
            } else {
                entries.serialize_entry(key, &Opaque::from_value(value.clone()))?;
            }
        }
        entries.end()
    }
}

struct Shared<'a, T>(&'a [Rc<T>]);

impl<T: Serialize> Serialize for Shared<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for value in self.0 {
            seq.serialize_element(value.as_ref())?;
        }
        seq.end()
    }
}

fn serialize_shared<S: Serializer, T: Serialize>(
    values: &[Rc<T>],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    Shared(values).serialize(serializer)
}

pub fn empty_ownership_journal_v5() -> AgentOwnershipJournalFileV5 {
    AgentOwnershipJournalFileV5 {
        root: Rc::new(Opaque::from_value(
            json!({ "version": AGENT_OWNERSHIP_JOURNAL_VERSION, "ownershipIntents": [] }),
        )),
        intents: Vec::new(),
    }
}

pub fn is_empty_earlier_journal(raw: &Value) -> bool {
    let empty = |value: &Value| value.as_array().is_some_and(Vec::is_empty);
    raw.is_object()
        && number(&raw["version"])
            .is_some_and(|version| version < AGENT_OWNERSHIP_JOURNAL_VERSION as i64)
        && empty(&raw["ownershipIntents"])
        && raw.get("transferCleanup").is_none_or(empty)
}

pub fn is_journal_v5(raw: &Value) -> bool {
    parse_v5(raw).is_some()
}

pub(crate) fn parse_v5(raw: &Value) -> Option<AgentOwnershipJournalFileV5> {
    if number(&raw["version"]) != Some(AGENT_OWNERSHIP_JOURNAL_VERSION as i64) {
        return None;
    }
    let intents = raw["ownershipIntents"]
        .as_array()?
        .iter()
        .map(parse_intent)
        .map(|intent| intent.map(Rc::new))
        .collect::<Option<Vec<_>>>()?;
    let mut root = raw.as_object()?.clone();
    root.insert("ownershipIntents".into(), Value::Null);
    Some(AgentOwnershipJournalFileV5 {
        root: Rc::new(Opaque::from_value(Value::Object(root))),
        intents,
    })
}

fn parse_intent(raw: &Value) -> Option<StoredIntent> {
    let operation_id = string(raw, "operationId")?;
    let chat_id = string(raw, "chatId")?;
    let value = match raw["kind"].as_str()? {
        "handoff" => OwnershipIntent::Handoff(Box::new(parse_handoff(raw, operation_id, chat_id)?)),
        "delete" => OwnershipIntent::Delete(parse_delete(raw, operation_id, chat_id)?),
        _ => return None,
    };
    Some(StoredIntent {
        value,
        wire: Opaque::from_value(raw.clone()),
    })
}

fn parse_handoff(raw: &Value, operation_id: String, chat_id: String) -> Option<AgentHandoffIntent> {
    if number(&raw["version"]) != Some(5) {
        return None;
    }
    let phase = match raw["phase"].as_str()? {
        "commit-decided" => HandoffPhase::CommitDecided,
        "registry-committed" => HandoffPhase::RegistryCommitted,
        _ => return None,
    };
    let client_request_id = string(raw, "clientRequestId")?;
    let submitted_target_hash = string(raw, "submittedTargetHash")?;
    if submitted_target_hash.len() != 64
        || !submitted_target_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let source = &raw["source"];
    let source = HandoffSource {
        executor_id: executor(source.as_object()?)?,
        agent_id: nonempty(source, "agentId")?,
        agent_ownership_epoch: nonempty(source, "agentOwnershipEpoch")?,
    };
    let target = &raw["target"];
    let target = HandoffTarget {
        execution: parse_execution_target(&target["execution"])?,
        agent_ownership_epoch: nonempty(target, "agentOwnershipEpoch")?,
    };
    let watermark = &raw["watermark"];
    let watermark = TranscriptWatermark {
        view_id: nonempty(watermark, "viewId")?,
        ordinal: u64::try_from(number(&watermark["ordinal"])?).ok()?,
    };
    Some(AgentHandoffIntent {
        version: 5,
        operation_id,
        client_request_id,
        submitted_target_hash,
        kind: "handoff",
        chat_id,
        phase,
        source,
        target,
        watermark,
        created_at: string(raw, "createdAt")?,
    })
}

fn parse_execution_target(raw: &Value) -> Option<ResolvedAgentHandoffTarget> {
    let settings = parse_agent_settings_envelope(&raw["agentSettings"]);
    let agent_id = nonempty(raw, "agentId")?;
    let executor_id = executor(raw.as_object()?)?;
    let project_path = if raw.get("projectPath").is_some() {
        Some(nonempty(raw, "projectPath")?)
    } else {
        None
    };
    let model = string(raw, "model")?;
    let api_provider_id = nullable_string(raw, "apiProviderId")?;
    let model_endpoint_id = nullable_string(raw, "modelEndpointId")?;
    let model_protocol = match raw.get("modelProtocol")? {
        Value::Null => None,
        Value::String(value) if value == "anthropic-messages" => {
            Some(ApiProtocol::AnthropicMessages)
        }
        Value::String(value) if value == "openai-compatible" => Some(ApiProtocol::OpenAiCompatible),
        _ => return None,
    };
    let permission_mode = is_permission_mode(&raw["permissionMode"])?;
    let thinking_mode = is_thinking_mode(&raw["thinkingMode"])?;
    let agent_settings = settings.filter(|settings| settings.owner_id == agent_id)?;
    Some(ResolvedAgentHandoffTarget {
        executor_id,
        project_path,
        agent_id,
        model,
        api_provider_id,
        model_endpoint_id,
        model_protocol,
        permission_mode,
        thinking_mode,
        agent_settings,
    })
}

fn parse_delete(raw: &Value, operation_id: String, chat_id: String) -> Option<DeleteIntent> {
    if number(&raw["version"]) != Some(2) {
        return None;
    }
    let phase = match raw["phase"].as_str()? {
        "prepared" => DeletePhase::Prepared,
        "registry-removed" => DeletePhase::RegistryRemoved,
        _ => return None,
    };
    let source_epoch = nullable_string(raw, "sourceEpoch")?;
    let release_references = raw["releaseReferences"]
        .as_array()?
        .iter()
        .map(parse_release_ref)
        .map(|reference| reference.map(Rc::new))
        .collect::<Option<Vec<_>>>()?;
    Some(DeleteIntent {
        version: 2,
        operation_id,
        kind: "delete",
        chat_id,
        phase,
        source_epoch,
        release_references,
        created_at: string(raw, "createdAt")?,
    })
}

fn parse_release_ref(raw: &Value) -> Option<ReleaseReference> {
    let settings = parse_agent_settings_envelope(&raw["settings"]);
    let chat_id = nonempty(raw, "chatId")?;
    let executor_id = executor(raw.as_object()?)?;
    let agent_id = nonempty(raw, "agentId")?;
    let agent_session_id = nullable_string(raw, "agentSessionId")?;
    let project_path = string(raw, "projectPath")?;
    let model = string(raw, "model")?;
    let native_session = match raw.get("nativeSession")? {
        Value::Null => None,
        value => {
            let owner_id = string(value, "ownerId")?;
            let schema_version =
                number(&value["schemaVersion"]).filter(|version| *version >= 1)? as u64;
            let payload = value.get("value").filter(|payload| payload.is_object())?;
            if owner_id != agent_id {
                return None;
            }
            Some(AgentNativeSessionRef {
                owner_id,
                schema_version,
                value: Opaque::from_value(payload.clone()),
            })
        }
    };
    let carry_over_revision = string(raw, "carryOverRevision")?;
    let settings = settings.filter(|settings| settings.owner_id == agent_id)?;
    let chat = AgentChatReference {
        chat_id,
        agent_id,
        agent_session_id,
        project_path,
        model,
        native_session,
        carry_over_revision,
        // The original journal validator does not inspect this optional release detail.
        native_seed_receipt: parse_native_seed_receipt(&raw["nativeSeedReceipt"]),
        settings,
    };
    Some(ReleaseReference {
        executor_id,
        chat,
        wire: Opaque::from_value(raw.clone()),
    })
}

fn number(value: &Value) -> Option<i64> {
    as_number(value)
        .filter(|value| is_safe_integer(*value))
        .map(|value| value as i64)
}

fn string(raw: &Value, field: &str) -> Option<String> {
    raw.get(field)?.as_str().map(str::to_owned)
}

fn nonempty(raw: &Value, field: &str) -> Option<String> {
    string(raw, field).filter(|value| !value.is_empty())
}

fn nullable_string(raw: &Value, field: &str) -> Option<Option<String>> {
    match raw.get(field)? {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text.clone())),
        _ => None,
    }
}

fn executor(raw: &Map<String, Value>) -> Option<OptionalNullable<ExecutorId>> {
    match raw.get("executorId") {
        None => Some(OptionalNullable::ABSENT),
        Some(Value::Null) => Some(OptionalNullable::NULL),
        Some(value) => parse_executor_id(value).map(OptionalNullable::some),
    }
}

pub(crate) fn omit_empty_executor(
    executor: OptionalNullable<ExecutorId>,
) -> OptionalNullable<ExecutorId> {
    executor
        .as_option()
        .filter(|value| !value.is_empty())
        .map_or(OptionalNullable::ABSENT, |value| {
            OptionalNullable::some(value.clone())
        })
}
