//! Ports `server-agents/interface/src/contracts/producer.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_types::{ChatMessage, ToolUseChatMessage, parse_chat_message, parse_tool_use_message},
    command_output::{CommandWorkingDirectory, parse_command_working_directory},
    transcript_seed::NativeSeedReceipt,
};
use garcon_js::json::Opaque;
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use serde_json::Value;

use crate::{
    execution_v5::AgentExecutionHandle,
    resources::{
        AgentPermissionResponseRef, AgentProducerBinding, AgentResourceScope, ExecutorCallOptions,
        ExecutorResult,
    },
    transcript::AgentNativeSessionRef,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProducedRow {
    #[serde(deserialize_with = "deserialize_message")]
    pub message: ChatMessage,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_provider_meta"
    )]
    pub provider_meta: Option<Opaque>,
}

pub(crate) fn deserialize_message<'de, D: Deserializer<'de>>(
    wire: D,
) -> Result<ChatMessage, D::Error> {
    let raw = Value::deserialize(wire)?;
    parse_chat_message(&raw)
        .map_err(D::Error::custom)?
        .ok_or_else(|| D::Error::custom("Unknown normalized message"))
}

pub(crate) fn deserialize_provider_meta<'de, D: Deserializer<'de>>(
    wire: D,
) -> Result<Option<Opaque>, D::Error> {
    let metadata = Option::<Opaque>::deserialize(wire)?;
    if metadata.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(D::Error::custom("providerMeta must be an object"));
    }
    Ok(metadata)
}

fn deserialize_requested_tool<'de, D: Deserializer<'de>>(
    wire: D,
) -> Result<Box<ToolUseChatMessage>, D::Error> {
    let raw = Value::deserialize(wire)?;
    parse_tool_use_message(&raw)
        .map(Box::new)
        .ok_or_else(|| D::Error::custom("Invalid permission tool"))
}

fn deserialize_working_directory<'de, D: Deserializer<'de>>(
    wire: D,
) -> Result<Option<CommandWorkingDirectory>, D::Error> {
    let raw = Value::deserialize(wire)?;
    parse_command_working_directory(&raw)
        .map(Some)
        .ok_or_else(|| D::Error::custom("Invalid completion working directory"))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEstablishedSession {
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub native_seed_receipt: Option<NativeSeedReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Opaque")]
pub struct AgentPermissionOption(Opaque);

impl TryFrom<Opaque> for AgentPermissionOption {
    type Error = &'static str;

    fn try_from(option: Opaque) -> Result<Self, Self::Error> {
        if option.get("id").is_some_and(Value::is_string)
            && option.get("label").is_some_and(Value::is_string)
        {
            Ok(Self(option))
        } else {
            Err("permission option must have a string id and label")
        }
    }
}

impl AgentPermissionOption {
    pub fn as_json(&self) -> &Opaque {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRequestedPermission {
    Requested {
        permission_occurrence_id: String,
        #[serde(deserialize_with = "deserialize_requested_tool")]
        requested_tool: Box<ToolUseChatMessage>,
        options: Vec<AgentPermissionOption>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentTerminalPermission {
    Cancelled {
        permission_occurrence_id: String,
        reason: Option<String>,
    },
    Expired {
        permission_occurrence_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentProviderPermissionLifecycle {
    Requested(AgentRequestedPermission),
    Terminal(AgentTerminalPermission),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentResolvedPermission {
    Resolved {
        permission_occurrence_id: String,
        decision: PermissionDecisionPayload,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentPermissionLifecycle {
    Provider(AgentProviderPermissionLifecycle),
    Resolved(AgentResolvedPermission),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionResponseCapability {
    pub permission_occurrence_id: String,
    pub response: AgentPermissionResponseRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum AgentProducerPermission {
    Requested {
        lifecycle: AgentRequestedPermission,
        decision: AgentPermissionResponseCapability,
    },
    Terminal {
        lifecycle: AgentTerminalPermission,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunFailureDetail {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AgentFinalResponse {
    Text { text: String },
    LiteralText { text: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRunOutcome {
    Finished {
        #[serde(skip_serializing_if = "Option::is_none")]
        final_response: Option<AgentFinalResponse>,
    },
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<AgentRunFailureDetail>,
    },
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentProducerEvent {
    Rows {
        rows: Vec<AgentProducedRow>,
    },
    Session {
        session: AgentEstablishedSession,
    },
    Permission {
        run_id: String,
        #[serde(flatten)]
        permission: AgentProducerPermission,
    },
    Notice {
        run_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    RunEnded {
        run_id: String,
        #[serde(flatten)]
        outcome: AgentRunOutcome,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_working_directory"
        )]
        working_directory: Option<CommandWorkingDirectory>,
    },
}

pub trait AgentProducerSink {
    fn publish(&self, event: AgentProducerEvent) -> ExecutorResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum AgentLaunchOutcome {
    Started { handle: AgentExecutionHandle },
    Failed { error: AgentRunFailureDetail },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentProducerControlEvent {
    Started {
        run_id: String,
    },
    Steerable {
        run_id: String,
    },
    PublicationFailed {
        error: AgentRunFailureDetail,
    },
    PublicationGap,
    LaunchSettled {
        run_id: String,
        #[serde(flatten)]
        outcome: AgentLaunchOutcome,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentProducerNotificationEvent {
    Provider(AgentProducerEvent),
    Control(AgentProducerControlEvent),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentProducerNotification {
    pub binding: AgentProducerBinding,
    pub event: AgentProducerNotificationEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProducerBindRequest {
    pub binding: AgentProducerBinding,
    pub chat_id: String,
}

#[async_trait(?Send)]
pub trait AgentProducers {
    /// Captures the scope of the currently available executor instance.
    fn scope(&self) -> ExecutorResult<AgentResourceScope>;
    async fn bind(
        &self,
        request: AgentProducerBindRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
    async fn close(
        &self,
        binding: AgentProducerBinding,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
    fn detach(&self, binding: AgentProducerBinding);
    fn subscribe(
        &self,
        listener: Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>,
    ) -> Box<dyn Fn()>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPermissionRespondRequest {
    pub response: AgentPermissionResponseRef,
    pub decision: PermissionDecisionPayload,
}

#[async_trait(?Send)]
pub trait AgentPermissions {
    async fn respond(
        &self,
        request: AgentPermissionRespondRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
}
