use garcon_cases::{CaseError, javascript_number, markers, replay, text, unknown};
use garcon_contract::chat_types::{
    ChatMessage, CommandOutputChannel, CommandOutputFormat, CommandOutputMessage,
    ToolUseChatMessage, parse_chat_message,
};
use garcon_contract::command_output::CommandOutputContext;
use garcon_contract::{
    chat_snapshot, chat_view, command_output_projection, transcript_anchor_page,
    transcript_entry_categories,
};
use garcon_js::Number;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn to_value(result: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&result).unwrap()).unwrap()
}

fn wire(result: impl Serialize) -> Value {
    json!(serde_json::to_string(&result).unwrap())
}

fn typed<T: DeserializeOwned>(function: &str, value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone()).map_err(|_| CaseError::unhandled(function))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawOutputChannel {
    Stdout,
    Stderr,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawOutputFormat {
    Plain,
    Markdown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommandOutput {
    timestamp: String,
    command_id: String,
    channel: RawOutputChannel,
    format: RawOutputFormat,
    content: String,
    context: Option<CommandOutputContext>,
    offset: u64,
}

impl From<RawCommandOutput> for CommandOutputMessage {
    fn from(output: RawCommandOutput) -> Self {
        Self {
            timestamp: output.timestamp,
            command_id: output.command_id,
            channel: match output.channel {
                RawOutputChannel::Stdout => CommandOutputChannel::Stdout,
                RawOutputChannel::Stderr => CommandOutputChannel::Stderr,
            },
            format: match output.format {
                RawOutputFormat::Plain => CommandOutputFormat::Plain,
                RawOutputFormat::Markdown => CommandOutputFormat::Markdown,
            },
            content: output.content,
            context: output.context,
            offset: output.offset,
        }
    }
}

#[test]
fn chat_snapshot_original_cases_match() {
    let cases = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/cases/common/chat-snapshot"
    );
    let stats = replay(cases, |function, args| match function {
        "parseChatSnapshotResponse" => {
            let value = unknown(function, args.first())?;
            let snapshot = chat_snapshot::parse_chat_snapshot_response(&value)
                .map_err(|error| CaseError::new(error.name(), error.to_string()))?;
            let mut encoded = to_value(&snapshot);
            if let chat_snapshot::ChatSnapshotTranscript::Available(page) = &snapshot.transcript {
                let rows = encoded["transcript"]["messages"].as_array_mut().unwrap();
                for (row, entry) in rows.iter_mut().zip(&page.messages) {
                    let name = match &entry.message {
                        ChatMessage::Assistant(_) => "AssistantMessage",
                        ChatMessage::Error(_) => "ErrorMessage",
                        ChatMessage::ToolUse(ToolUseChatMessage::Bash { .. }) => {
                            "BashToolUseMessage"
                        }
                        _ => return Err(CaseError::unhandled(function)),
                    };
                    let fields = row["message"].take().as_object().unwrap().clone();
                    row["message"] = markers::instance(name, fields);
                }
            }
            Ok(encoded)
        }
        "new ChatSnapshotContractError" => {
            let message =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            let error = chat_snapshot::ChatSnapshotContractError::new(message);
            Ok(
                json!({"$": "error", "name": error.name(), "message": error.to_string(), "properties": {}}),
            )
        }
        _ => Err(CaseError::unhandled(function)),
    });
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn anchor_pages_accept_wide_public_and_hidden_intervals() {
    use transcript_anchor_page::*;
    let messages: Vec<_> = (1..=5_000)
        .map(|ordinal| json!({"ordinal": ordinal, "message": {"type": "bash-tool-use", "toolId": ordinal.to_string(), "command": "true"}}))
        .collect();

    for direction in ["backward", "forward"] {
        let request = parse_transcript_anchor_request(&json!({
            "chatId": "synthetic-chat", "direction": direction, "anchorsRemaining": 1,
        }))
        .unwrap();
        let mut response = json!({
            "historyState": {"kind": "complete"}, "chatId": "synthetic-chat",
            "transcriptViewId": "fixture", "direction": direction, "watermarkOrdinal": 5_000,
            "lastOrdinal": 5_000, "startOrdinal": 1, "endOrdinal": 5_001,
            "anchorsRemaining": 1, "pageStatus": "exhausted", "messages": messages,
            "resendCandidates": [],
        });
        let TranscriptAnchorResponse::Complete(page) =
            parse_transcript_anchor_response(&request, &response).unwrap()
        else {
            panic!("expected a served page")
        };
        assert_eq!(page.messages.len(), messages.len());
        response["messages"] = json!([]);
        let TranscriptAnchorResponse::Complete(page) =
            parse_transcript_anchor_response(&request, &response).unwrap()
        else {
            panic!("expected a hidden-only served page")
        };
        let window = transcript_anchor_window(&page).unwrap();
        assert_eq!(
            (window.page_oldest_ordinal, window.page_newest_ordinal),
            (0, 5_000)
        );
        response["anchorsRemaining"] = json!(0);
        assert!(parse_transcript_anchor_response(&request, &response).is_err());
        response["anchorsRemaining"] = json!(1);
        response["messages"] = json!(messages.iter().rev().collect::<Vec<_>>());
        assert!(parse_transcript_anchor_response(&request, &response).is_err());
    }
}

#[test]
fn a_constructed_notice_with_invalid_quarantine_fields_is_diagnostic() {
    use garcon_contract::chat_types::TranscriptNoticeMessage;
    use garcon_contract::transcript_notice_details::TranscriptNoticeDetail;
    use transcript_entry_categories::*;

    let message = ChatMessage::Notice(TranscriptNoticeMessage {
        timestamp: String::new(),
        content: String::new(),
        detail: Some(TranscriptNoticeDetail::CarryoverMigrationQuarantine {
            artifact_id: String::new(),
            error_code: "INVALID_ARTIFACT".to_owned(),
        }),
        title: None,
    });
    assert_eq!(
        transcript_entry_category_for_message(&message),
        TranscriptEntryCategory::Optional(TranscriptEntryOptionalCategory::Diagnostics),
    );
}

#[test]
fn transcript_page_cases_match() {
    use chat_view::*;
    use transcript_anchor_page::*;
    use transcript_entry_categories::*;
    let cases = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/cases/common/transcript-page"
    );
    let stats = replay(cases, |function, args| {
        let first = unknown(function, args.first())?;
        let type_error =
            |error: garcon_contract::async_user_questions::InvalidAsyncQuestionReply| {
                CaseError::new("TypeError", error.to_string())
            };
        match function {
            "parseTranscriptMessage" => parse_transcript_message(&first)
                .map(wire)
                .map_err(type_error),
            "parseTranscriptMessages" => parse_transcript_messages(&first)
                .map(wire)
                .map_err(type_error),
            "applyTranscriptAppend" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Change {
                    first_ordinal: Number,
                    last_ordinal: Number,
                    messages: Value,
                }
                let messages = |value| {
                    parse_transcript_messages(value)
                        .map_err(type_error)?
                        .ok_or_else(|| CaseError::unhandled(function))
                };
                let change = unknown(function, args.get(1))?;
                let change: Change = typed(function, &change)?;
                let append = TranscriptAppend {
                    transcript_view_id: String::new(),
                    first_ordinal: change.first_ordinal,
                    last_ordinal: change.last_ordinal,
                    messages: messages(&change.messages)?,
                };
                let last = Number(javascript_number(function, args.get(2))?);
                Ok(wire(apply_transcript_append(
                    messages(&first)?,
                    &append,
                    last,
                )))
            }
            "parseResendCandidates" => Ok(to_value(parse_resend_candidates(&first))),
            "parseChatHistoryState" => Ok(to_value(parse_chat_history_state(&first))),
            "parseChatHistoryResponse" => {
                let request = typed(function, &first)?;
                let value = unknown(function, args.get(1))?;
                parse_chat_history_response(&request, &value)
                    .map(wire)
                    .map_err(|error| CaseError::new(error.name(), error.to_string()))
            }
            "parseChatSnapshotResponse" => chat_snapshot::parse_chat_snapshot_response(&first)
                .map(wire)
                .map_err(|error| CaseError::new(error.name(), error.to_string())),
            "parseTranscriptAnchorRequest" => parse_transcript_anchor_request(&first)
                .map(to_value)
                .map_err(|error| CaseError::new("Error", error.to_string())),
            "parseTranscriptAnchorResponse" | "anchorWindow" | "anchorContinuation" => {
                let request = typed(function, &first)?;
                let value = unknown(function, args.get(1))?;
                let page = parse_transcript_anchor_response(&request, &value)
                    .map_err(|error| CaseError::new(error.name(), error.to_string()))?;
                if function == "parseTranscriptAnchorResponse" {
                    return Ok(wire(page));
                }
                let TranscriptAnchorResponse::Complete(page) = page else {
                    return Err(CaseError::unhandled(function));
                };
                match function {
                    "anchorWindow" => transcript_anchor_window(&page)
                        .map(wire)
                        .map_err(|error| CaseError::new("Error", error.to_string())),
                    "anchorContinuation" => Ok(to_value(transcript_anchor_continuation(&page))),
                    _ => Err(CaseError::unhandled(function)),
                }
            }
            "isTranscriptEntryOptionalCategory" => Ok(json!(
                is_transcript_entry_optional_category(&first).is_some()
            )),
            "canonicalTranscriptEntryOptionalCategories" => {
                let values: Vec<TranscriptEntryOptionalCategory> = typed(function, &first)?;
                Ok(to_value(canonical_transcript_entry_optional_categories(
                    values,
                )))
            }
            "transcriptEntryCategoryForMessage" => {
                let msg = parse_chat_message(&first)
                    .map_err(type_error)?
                    .ok_or_else(|| CaseError::unhandled(function))?;
                Ok(to_value(transcript_entry_category_for_message(&msg)))
            }
            "projectCommandOutput" => {
                let messages = first
                    .as_array()
                    .ok_or_else(|| CaseError::unhandled(function))?
                    .iter()
                    .map(|raw| {
                        if raw["type"] == "command-output" {
                            let output: RawCommandOutput = typed(function, raw)?;
                            Ok(Some(ChatMessage::CommandOutput(output.into())))
                        } else {
                            parse_chat_message(raw).map_err(type_error)
                        }
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let projected = command_output_projection::project_command_output(&messages);
                let rows: Vec<_> = projected.iter().map(|(index, result)| {
                    let same = matches!(&messages[*index], Some(ChatMessage::CommandOutput(input)) if std::ptr::eq(result.as_ref(), input));
                    (index, result, same)
                }).collect();
                Ok(wire(rows))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}
