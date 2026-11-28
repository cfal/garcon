use garcon_base::{
    errors::{ErrorInput, js_string},
    stored_json::parse_stored_json,
};
use garcon_contract::{
    agent_execution::{AgentAttachment, AgentAttachmentKind},
    chat_command_contracts::{PermissionDecisionPayload, PermissionDecisionResponse},
    chat_types::{ChatMessage, parse_chat_message},
    cli_presentation::{
        CliPresentation, CliRowFormat, coerce_durable_cli_body_disclosure,
        coerce_durable_cli_presentation, is_cli_presentation, is_cli_row_format,
    },
    executors::is_executor_id,
    json::stable_json_stringify,
    preamble_prefix::parse_preamble_prefix_receipt,
    preambles::normalize_pending_preamble_boundary,
    transcript_seed::parse_native_seed_receipt,
};
use garcon_interface::{
    producer::{AgentEstablishedSession, AgentPermissionOption, AgentRunFailureDetail},
    transcript::AgentNativeSessionRef,
};
use garcon_js::{
    Number, is_safe_integer,
    json::{self, Opaque, as_number},
};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{
    contracts::{
        LedgerAgentSwitchDetail, LedgerCliRowNoticeDetail, LedgerNoticeDetail,
        LedgerPermissionLifecycle, LedgerPermissionTool,
        LedgerPreambleSelectionChangedNoticeDetail, LedgerRow, LedgerRowData, LedgerRowDraft,
        LedgerUserInputDetail, RunOrigin, RunOutcome, TranscriptViewId,
        is_ledger_cli_row_notice_detail, is_ledger_preamble_selection_changed_notice_detail,
    },
    errors::{LedgerCodecError, UndecodableLedgerRowError},
};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredLedgerRow {
    pub view_id: String,
    pub ordinal: Number,
    pub kind: String,
    pub at: String,
    pub client_message_id: Option<String>,
    pub payload_json: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedLedgerDraft {
    pub client_message_id: Option<String>,
    pub payload_json: String,
}

pub fn encode_ledger_draft(draft: &LedgerRowDraft) -> Result<EncodedLedgerDraft, LedgerCodecError> {
    use LedgerRowData::*;
    let client_message_id = match &draft.data {
        UserInput { detail } => detail.client_message_id.clone(),
        Notice { detail, .. } => match detail {
            LedgerNoticeDetail::CliRow(detail) => Some(detail.client_message_id.clone()),
            LedgerNoticeDetail::PreambleSelectionChanged(detail) => {
                Some(detail.client_message_id.clone())
            }
            LedgerNoticeDetail::Other(detail)
                if is_ledger_cli_row_notice_detail(detail)
                    || is_ledger_preamble_selection_changed_notice_detail(detail) =>
            {
                detail["clientMessageId"].as_str().map(str::to_owned)
            }
            LedgerNoticeDetail::Other(_) => None,
        },
        _ => None,
    };
    let value = match &draft.data {
        UserInput { detail } => serialized_value(detail),
        ProviderRow { message } => serialized_value(message),
        Notice { message, detail } => Ok(serde_json::json!({
            "message": message,
            "detail": serialized_value(detail)?,
        })),
        AgentSwitch { detail } => serialized_value(detail),
        Session { detail } => serialized_value(detail),
        RunEnded {
            outcome,
            origin,
            error,
        } => {
            let mut value = Map::new();
            value.insert("outcome".into(), serialized_value(outcome)?);
            value.insert("origin".into(), serialized_value(origin)?);
            if let Some(error) = error {
                value.insert("error".into(), serialized_value(error)?);
            }
            Ok(Value::Object(value))
        }
        PermissionRequested { lifecycle }
        | PermissionResolved { lifecycle }
        | PermissionCancelled { lifecycle }
        | PermissionExpired { lifecycle } => encode_permission_lifecycle(lifecycle),
    }?;
    let payload_json = stable_json_stringify(&serde_json::json!({
        "providerMeta": draft.provider_meta.as_ref().map(Opaque::as_value),
        "value": value,
    }));
    Ok(EncodedLedgerDraft {
        client_message_id,
        payload_json,
    })
}

struct RowFields<'a> {
    view_id: &'a str,
    ordinal: Option<f64>,
    kind: Result<&'a str, Option<&'a Value>>,
    at: Option<&'a str>,
    client_message_id: Option<Option<&'a str>>,
}

pub fn decode_ledger_row(row: &StoredLedgerRow) -> Result<LedgerRow, LedgerCodecError> {
    decode_row(
        &row.payload_json,
        RowFields {
            view_id: &row.view_id,
            ordinal: Some(row.ordinal.0),
            kind: Ok(&row.kind),
            at: Some(&row.at),
            client_message_id: Some(row.client_message_id.as_deref()),
        },
    )
}

fn decode_row(payload_json: &str, fields: RowFields<'_>) -> Result<LedgerRow, LedgerCodecError> {
    let (provider_meta, value) = parse_payload(payload_json)?;
    let ordinal = positive_integer(fields.ordinal, "ordinal")?;
    let at = non_empty_string(fields.at, "row timestamp")?;
    let kind = fields.kind.map_err(|kind| {
        let value = kind.map_or(ErrorInput::Undefined, ErrorInput::Json);
        type_error(format!("Unknown transcript row kind: {}", js_string(value)))
    })?;
    let data = decode_row_data(
        kind,
        &value,
        fields.client_message_id,
        provider_meta.is_none(),
    )?;
    Ok(LedgerRow {
        view_id: TranscriptViewId(fields.view_id.into()),
        ordinal,
        at,
        provider_meta,
        data,
    })
}

fn decode_row_data(
    kind: &str,
    value: &Value,
    client_message_id: Option<Option<&str>>,
    provider_meta_is_null: bool,
) -> Result<LedgerRowData, LedgerCodecError> {
    use LedgerRowData::*;
    Ok(match kind {
        "user-input" => {
            let detail = parse_user_input(value)?;
            if Some(detail.client_message_id.as_deref()) != client_message_id {
                return Err(type_error(
                    "Stored user-input identity does not match its payload",
                ));
            }
            UserInput { detail }
        }
        "provider-row" => ProviderRow {
            message: parse_message(value)?,
        },
        "notice" => {
            let value = record(value, "notice payload")?;
            let message = non_empty_string(
                value.get("message").and_then(Value::as_str),
                "notice message",
            )?;
            let detail = json_object(field(value, "detail"), "notice detail")?;
            let cli_detail = parse_ledger_cli_row_notice_detail(&detail)?;
            let selection_detail = parse_ledger_preamble_selection_changed_notice_detail(&detail)?;
            let detail = if let Some(cli_detail) = cli_detail {
                if client_message_id != Some(Some(cli_detail.client_message_id.as_str())) {
                    return Err(type_error(
                        "Stored chat row identity does not match its payload",
                    ));
                }
                if !provider_meta_is_null {
                    return Err(type_error("Stored chat row provider metadata must be null"));
                }
                LedgerNoticeDetail::CliRow(cli_detail)
            } else if let Some(selection_detail) = selection_detail {
                if client_message_id != Some(Some(selection_detail.client_message_id.as_str())) {
                    return Err(type_error(
                        "Stored preamble selection notice identity does not match its payload",
                    ));
                }
                if !provider_meta_is_null {
                    return Err(type_error(
                        "Stored preamble selection notice provider metadata must be null",
                    ));
                }
                LedgerNoticeDetail::PreambleSelectionChanged(selection_detail)
            } else {
                if client_message_id != Some(None) {
                    return Err(type_error(
                        "Stored notice has an unexpected client message identity",
                    ));
                }
                LedgerNoticeDetail::Other(detail)
            };
            Notice { message, detail }
        }
        "agent-switch" => AgentSwitch {
            detail: parse_agent_switch(value)?,
        },
        "session" => Session {
            detail: parse_session(value)?,
        },
        "run-ended" => {
            let value = record(value, "run-ended payload")?;
            let outcome = match value.get("outcome").and_then(Value::as_str) {
                Some("finished") => RunOutcome::Finished,
                Some("failed") => RunOutcome::Failed,
                Some("interrupted") => RunOutcome::Interrupted,
                _ => return Err(type_error("Stored run outcome is invalid")),
            };
            let origin = match value.get("origin").and_then(Value::as_str) {
                Some("provider") => RunOrigin::Provider,
                Some("core") => RunOrigin::Core,
                _ => return Err(type_error("Stored run origin is invalid")),
            };
            let error = value.get("error").map(parse_run_failure).transpose()?;
            RunEnded {
                outcome,
                origin,
                error,
            }
        }
        "permission-requested"
        | "permission-resolved"
        | "permission-cancelled"
        | "permission-expired" => {
            let lifecycle = parse_permission_lifecycle(value)?;
            if kind != lifecycle.row_kind() {
                return Err(type_error(
                    "Stored permission kind does not match its lifecycle payload",
                ));
            }
            match kind {
                "permission-requested" => PermissionRequested { lifecycle },
                "permission-resolved" => PermissionResolved { lifecycle },
                "permission-cancelled" => PermissionCancelled { lifecycle },
                _ => PermissionExpired { lifecycle },
            }
        }
        _ => return Err(type_error(format!("Unknown transcript row kind: {kind}"))),
    })
}

pub fn decode_stored_ledger_row(
    row: &StoredLedgerRow,
) -> Result<LedgerRow, UndecodableLedgerRowError> {
    decode_ledger_row(row).map_err(|cause| UndecodableLedgerRowError { cause })
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeClonedStoredRowsError {
    #[error("Received an invalid stored transcript row")]
    InvalidInput,
    #[error(transparent)]
    InvalidRow(#[from] UndecodableLedgerRowError),
}

pub fn decode_cloned_stored_rows(
    items: &[Value],
) -> Result<Vec<LedgerRow>, DecodeClonedStoredRowsError> {
    items
        .iter()
        .map(|item| {
            let (Some(value), Some(payload_json)) =
                (item.as_object(), item["payload_json"].as_str())
            else {
                return Err(DecodeClonedStoredRowsError::InvalidInput);
            };
            let kind = value.get("kind");
            let row = decode_row(
                payload_json,
                RowFields {
                    view_id: value
                        .get("view_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    ordinal: value.get("ordinal").and_then(as_number),
                    kind: kind.and_then(Value::as_str).ok_or(kind),
                    at: value.get("at").and_then(Value::as_str),
                    client_message_id: value.get("client_message_id").and_then(|value| {
                        if value.is_null() {
                            Some(None)
                        } else {
                            value.as_str().map(Some)
                        }
                    }),
                },
            )
            .map_err(|cause| UndecodableLedgerRowError { cause })?;
            Ok(row)
        })
        .collect()
}

pub fn submission_fingerprint(detail: &LedgerUserInputDetail) -> Result<String, LedgerCodecError> {
    let question_reply = detail
        .message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.question_reply.as_ref());
    Ok(stable_json_stringify(&serde_json::json!({
        "content": detail.message.content,
        "images": serialized_value(&detail.message.images)?,
        "presentation": serialized_value(&detail.message.presentation)?,
        "questionReply": serialized_value(&question_reply)?,
        "attachments": serialized_value(&detail.attachments)?,
        "steer": detail.steer,
    })))
}

pub fn cli_row_fingerprint(
    message: &str,
    detail: &LedgerCliRowNoticeDetail,
) -> Result<String, LedgerCodecError> {
    Ok(stable_json_stringify(&serde_json::json!({
        "presentation": detail.presentation.as_value(),
        "format": serialized_value(&detail.format)?,
        "disclosure": serialized_value(&detail.disclosure)?,
        "title": detail.title,
        "content": message,
    })))
}

pub fn parse_ledger_cli_row_notice_detail(
    value: &Value,
) -> Result<Option<LedgerCliRowNoticeDetail>, LedgerCodecError> {
    if value["type"] != "cli-row" {
        return Ok(None);
    }
    let invalid = || type_error("Stored chat row detail is invalid");
    let client_message_id = value["clientMessageId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?;
    let title = match value.get("title") {
        Some(Value::Null) => None,
        Some(Value::String(title)) if !title.is_empty() => Some(title.clone()),
        _ => return Err(invalid()),
    };
    let presentation = &value["presentation"];
    let presentation = if is_cli_presentation(presentation).is_some() {
        presentation.clone()
    } else {
        match coerce_durable_cli_presentation(presentation) {
            CliPresentation::Custom { .. } => serde_json::json!({
                "style": "custom", "customStyle": presentation["customStyle"],
            }),
            fallback => serialized_value(&fallback)?,
        }
    };
    Ok(Some(LedgerCliRowNoticeDetail {
        client_message_id: client_message_id.into(),
        presentation: presentation.into(),
        format: is_cli_row_format(&value["format"]).unwrap_or(CliRowFormat::Plain),
        disclosure: coerce_durable_cli_body_disclosure(&value["disclosure"]),
        title,
    }))
}

pub fn parse_ledger_preamble_selection_changed_notice_detail(
    value: &Value,
) -> Result<Option<LedgerPreambleSelectionChangedNoticeDetail>, LedgerCodecError> {
    if value["type"] != "preamble-selection-change" {
        return Ok(None);
    }
    let invalid = || type_error("Stored preamble selection notice detail is invalid");
    if !is_ledger_preamble_selection_changed_notice_detail(value) {
        return Err(invalid());
    }
    let text = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(invalid)
    };
    Ok(Some(LedgerPreambleSelectionChangedNoticeDetail {
        client_message_id: text("clientMessageId")?,
        request_fingerprint: text("requestFingerprint")?,
        selection_revision: as_number(&value["selectionRevision"]).ok_or_else(invalid)? as u64,
        preambles: value["preambles"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .cloned()
            .map(Opaque::from_value)
            .collect(),
    }))
}

fn parse_payload(text: &str) -> Result<(Option<Opaque>, Value), LedgerCodecError> {
    let parsed = parse_stored_json(text, "Ledger payload")?.into_value();
    let Value::Object(mut parsed) = parsed else {
        return Err(type_error("ledger payload must be an object"));
    };
    let provider_meta = match parsed.shift_remove("providerMeta") {
        Some(Value::Null) => None,
        Some(value @ Value::Object(_)) => Some(value.into()),
        _ => return Err(type_error("provider metadata must be an object")),
    };
    Ok((
        provider_meta,
        parsed.shift_remove("value").unwrap_or(Value::Null),
    ))
}

fn parse_user_input(value: &Value) -> Result<LedgerUserInputDetail, LedgerCodecError> {
    let detail = record(value, "user-input payload")?;
    let ChatMessage::User(message) = parse_message(field(detail, "message"))? else {
        return Err(type_error(
            "Stored user-input message is not a user message",
        ));
    };
    let client_message_id = nullable_string(detail, "clientMessageId", "client message ID")?;
    let attachments = detail
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or_else(|| type_error("Stored input attachments are invalid"))?
        .iter()
        .map(|attachment| {
            let item = record(attachment, "input attachment")?;
            if field(item, "kind") != "image" {
                return Err(type_error("Stored input attachment kind is invalid"));
            }
            Ok(AgentAttachment {
                kind: AgentAttachmentKind::Image,
                data: required_string(item, "data", "attachment data")?,
                name: nullable_string(item, "name", "attachment name")?,
                mime_type: required_string(item, "mimeType", "attachment MIME type")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let steer = detail
        .get("steer")
        .and_then(Value::as_bool)
        .ok_or_else(|| type_error("Stored steer flag is invalid"))?;
    let boundary = field(detail, "preambleBoundary");
    let receipt = field(detail, "preamblePrefixReceipt");
    let preamble_boundary = normalize_pending_preamble_boundary(boundary);
    let preamble_prefix_receipt = parse_preamble_prefix_receipt(receipt);
    if !boundary.is_null() && preamble_boundary.is_none() {
        return Err(type_error("Stored preamble boundary proof is invalid"));
    }
    if !receipt.is_null() && preamble_prefix_receipt.is_none() {
        return Err(type_error("Stored preamble prefix receipt is invalid"));
    }
    if preamble_prefix_receipt.is_some() && preamble_boundary.is_none() {
        return Err(type_error("Stored preamble receipt has no boundary proof"));
    }
    Ok(LedgerUserInputDetail {
        client_message_id,
        message,
        attachments,
        steer,
        preamble_boundary,
        preamble_prefix_receipt,
    })
}

fn parse_agent_switch(value: &Value) -> Result<LedgerAgentSwitchDetail, LedgerCodecError> {
    let detail = record(value, "agent switch payload")?;
    for key in ["fromExecutorId", "toExecutorId"] {
        if detail.get(key).is_some_and(|value| !is_executor_id(value)) {
            return Err(LedgerCodecError::InvalidAgentSwitchExecutor);
        }
    }
    let executor_id = |key| detail.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(LedgerAgentSwitchDetail {
        from_executor_id: executor_id("fromExecutorId"),
        to_executor_id: executor_id("toExecutorId"),
        from_agent_id: required_string(detail, "fromAgentId", "agent switch source")?,
        to_agent_id: required_string(detail, "toAgentId", "agent switch target")?,
        from_model: nullable_string(detail, "fromModel", "source model")?,
        to_model: nullable_string(detail, "toModel", "target model")?,
    })
}

fn parse_session(value: &Value) -> Result<AgentEstablishedSession, LedgerCodecError> {
    let session = record(value, "session payload")?;
    let agent_session_id = required_string(session, "agentSessionId", "agent session ID")?;
    let native_session = match session.get("nativeSession") {
        Some(Value::Null) => None,
        value => Some(parse_native_session(value.unwrap_or(&Value::Null))?),
    };
    let native_seed_receipt = match session.get("nativeSeedReceipt") {
        Some(Value::Null) => None,
        value => Some(
            value
                .and_then(parse_native_seed_receipt)
                .ok_or_else(|| type_error("Stored native seed receipt is invalid"))?,
        ),
    };
    if native_seed_receipt
        .as_ref()
        .is_some_and(|receipt| receipt.agent_session_id != agent_session_id)
    {
        return Err(type_error("Stored native seed receipt session mismatch"));
    }
    Ok(AgentEstablishedSession {
        agent_session_id,
        native_session,
        native_seed_receipt,
    })
}

fn parse_native_session(value: &Value) -> Result<AgentNativeSessionRef, LedgerCodecError> {
    let session = record(value, "native session")?;
    Ok(AgentNativeSessionRef {
        owner_id: required_string(session, "ownerId", "native session owner")?,
        schema_version: positive_integer(
            session.get("schemaVersion").and_then(as_number),
            "native session schema version",
        )?,
        value: json_object(field(session, "value"), "native session value")?,
    })
}

fn parse_permission_lifecycle(
    value: &Value,
) -> Result<LedgerPermissionLifecycle, LedgerCodecError> {
    use LedgerPermissionLifecycle::*;
    let lifecycle = record(value, "permission lifecycle")?;
    let permission_occurrence_id =
        required_string(lifecycle, "incarnation", "permission occurrence ID")?;
    Ok(match lifecycle.get("kind").and_then(Value::as_str) {
        Some("requested") => {
            let requested_tool = match parse_message(field(lifecycle, "requestedTool"))? {
                ChatMessage::ToolUse(tool) => LedgerPermissionTool::ToolUse(Box::new(tool)),
                ChatMessage::ToolResult(result) => LedgerPermissionTool::ToolResult(result),
                _ => return Err(type_error("Permission request tool is invalid")),
            };
            let options = lifecycle
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| type_error("Permission options are invalid"))?
                .iter()
                .map(|option| {
                    let option = json_object(option, "permission option")?;
                    non_empty_string(option["id"].as_str(), "permission option ID")?;
                    non_empty_string(option["label"].as_str(), "permission option label")?;
                    AgentPermissionOption::try_from(option).map_err(type_error)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let reason = lifecycle
                .get("reason")
                .map(|reason| non_empty_string(reason.as_str(), "permission request reason"))
                .transpose()?;
            Requested {
                permission_occurrence_id,
                requested_tool,
                options,
                reason,
            }
        }
        Some("resolved") => {
            let decision = record(field(lifecycle, "decision"), "permission decision")?;
            let allow = decision
                .get("allow")
                .and_then(Value::as_bool)
                .ok_or_else(|| type_error("Permission decision is invalid"))?;
            let decision = PermissionDecisionPayload {
                allow,
                always_allow: decision.get("alwaysAllow").and_then(Value::as_bool),
                response: decision
                    .get("response")
                    .filter(|value| value.is_object())
                    .cloned()
                    .map(|value| PermissionDecisionResponse::Provider(value.into())),
            };
            Resolved {
                permission_occurrence_id,
                decision,
            }
        }
        Some("cancelled") => Cancelled {
            permission_occurrence_id,
            reason: nullable_string(lifecycle, "reason", "permission cancellation reason")?,
        },
        Some("expired") => Expired {
            permission_occurrence_id,
        },
        _ => return Err(type_error("Stored permission lifecycle kind is invalid")),
    })
}

fn encode_permission_lifecycle(
    lifecycle: &LedgerPermissionLifecycle,
) -> Result<Value, LedgerCodecError> {
    let Value::Object(mut value) = serialized_value(lifecycle)? else {
        return Err(type_error("permission lifecycle must be an object"));
    };
    if let Some(id) = value.shift_remove("permissionOccurrenceId") {
        value.insert("incarnation".into(), id);
    }
    Ok(Value::Object(value))
}

fn parse_run_failure(value: &Value) -> Result<AgentRunFailureDetail, LedgerCodecError> {
    let error = record(value, "run failure")?;
    let message = error
        .get("message")
        .map(|message| non_empty_string(message.as_str(), "run failure message"))
        .transpose()?;
    Ok(AgentRunFailureDetail {
        code: required_string(error, "code", "run failure code")?,
        message,
    })
}

fn parse_message(value: &Value) -> Result<ChatMessage, LedgerCodecError> {
    record(value, "chat message")?;
    parse_chat_message(value)?.ok_or_else(|| type_error("Stored chat message is invalid"))
}

fn record<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, LedgerCodecError> {
    value
        .as_object()
        .ok_or_else(|| type_error(format!("{label} must be an object")))
}

fn json_object(value: &Value, label: &str) -> Result<Opaque, LedgerCodecError> {
    record(value, label)?;
    Ok(value.clone().into())
}

fn field<'a>(record: &'a Map<String, Value>, key: &str) -> &'a Value {
    record.get(key).unwrap_or(&Value::Null)
}

fn required_string(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, LedgerCodecError> {
    non_empty_string(record.get(key).and_then(Value::as_str), label)
}

fn nullable_string(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, LedgerCodecError> {
    match record.get(key) {
        Some(Value::Null) => Ok(None),
        value => non_empty_string(value.and_then(Value::as_str), label).map(Some),
    }
}

fn non_empty_string(value: Option<&str>, label: &str) -> Result<String, LedgerCodecError> {
    value
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| type_error(format!("{label} must be a non-empty string")))
}

fn positive_integer(value: Option<f64>, label: &str) -> Result<u64, LedgerCodecError> {
    value
        .filter(|&value| is_safe_integer(value) && value >= 1.0)
        .map(|value| value as u64)
        .ok_or_else(|| type_error(format!("{label} must be a positive integer")))
}

fn type_error(message: impl Into<String>) -> LedgerCodecError {
    LedgerCodecError::Type(message.into())
}

fn serialized_value(value: &impl Serialize) -> Result<Value, LedgerCodecError> {
    Ok(json::from_slice(&serde_json::to_vec(value)?)?)
}
