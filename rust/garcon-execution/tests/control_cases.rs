use std::cell::Cell;
use std::collections::HashSet;
use std::path::Path;

use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::chat_command_contracts::QueueEntryPlacement;
use garcon_contract::queue_state::{
    AutomaticQueuePauseKind, QueueEntryKind, QueuePause, QueuePauseKind,
    RecentlyDispatchedQueueEntry,
};
use garcon_contract::transcript_notice_details::parse_transcript_notice_detail;
use garcon_contract::ws_requests::AgentCommandImage;
use garcon_execution::chat_execution_control_transitions::*;
use garcon_execution::control_state::*;
use garcon_js::Number;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn directory(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/cases")
        .join(name)
}

fn serialized(value: impl Serialize) -> Value {
    let wire = serde_json::to_string(&value).unwrap();
    garcon_js::json::from_str(&wire).unwrap()
}

fn typed<T: DeserializeOwned>(value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn list<T>(
    value: &Value,
    decode: impl Fn(&Value) -> Result<T, CaseError>,
) -> Result<Vec<T>, CaseError> {
    value
        .as_array()
        .ok_or_else(|| CaseError::undeliverable("expected a list"))?
        .iter()
        .map(decode)
        .collect()
}

fn optional<T>(
    value: &Value,
    decode: impl FnOnce(&Value) -> Result<T, CaseError>,
) -> Result<Option<T>, CaseError> {
    if value.is_null() {
        Ok(None)
    } else {
        decode(value).map(Some)
    }
}

fn images(value: &Value) -> Result<Vec<AgentCommandImage>, CaseError> {
    list(value, |image| {
        Ok(AgentCommandImage {
            data: typed(&image["data"])?,
            name: typed(&image["name"])?,
            mime_type: typed(&image["mimeType"])?,
        })
    })
}

fn submission(value: &Value) -> Result<StoredQueueSubmissionIdentity, CaseError> {
    Ok(StoredQueueSubmissionIdentity {
        client_message_id: typed(&value["clientMessageId"])?,
        transcript_view_id: typed(&value["transcriptViewId"])?,
        excluded_resend_ordinals: optional(&value["excludedResendOrdinals"], |ordinals| {
            list(ordinals, |ordinal| typed(ordinal).map(Number))
        })?,
    })
}

fn stored_entry(entry: &Value) -> Result<StoredQueueEntry, CaseError> {
    Ok(StoredQueueEntry {
        id: typed(&entry["id"])?,
        content: typed(&entry["content"])?,
        kind: match entry["kind"].as_str() {
            Some("turn") => QueueEntryKind::Turn,
            Some("steer") => QueueEntryKind::Steer,
            _ => return Err(CaseError::undeliverable("invalid queue entry kind")),
        },
        images: images(&entry["images"])?,
        revision: typed(&entry["revision"])?,
        status: match entry["status"].as_str() {
            Some("queued") => StoredQueueEntryStatus::Queued,
            Some("steering") => StoredQueueEntryStatus::Steering,
            _ => return Err(CaseError::undeliverable("invalid stored queue status")),
        },
        created_at: typed(&entry["createdAt"])?,
        updated_at: typed(&entry["updatedAt"])?,
        submission: optional(&entry["submission"], submission)?,
    })
}

fn stored_pause(value: &Value) -> Result<QueuePause, CaseError> {
    let kind = match value["kind"].as_str() {
        Some("manual") => QueuePauseKind::Manual {
            paused_at: typed(&value["pausedAt"])?,
        },
        Some("queued-turn-failed") => QueuePauseKind::QueuedTurnFailed {
            entry_id: typed(&value["entryId"])?,
            paused_at: typed(&value["pausedAt"])?,
        },
        Some("turn-failed") => QueuePauseKind::TurnFailed {
            turn_id: typed(&value["turnId"])?,
            paused_at: typed(&value["pausedAt"])?,
        },
        Some("completion-uncertain") => QueuePauseKind::CompletionUncertain {
            entry_id: typed(&value["entryId"])?,
            paused_at: typed(&value["pausedAt"])?,
        },
        Some("unknown") => QueuePauseKind::Unknown {
            entry_id: typed(&value["entryId"])?,
            paused_at: typed(&value["pausedAt"])?,
        },
        _ => return Err(CaseError::undeliverable("invalid queue pause")),
    };
    Ok(QueuePause {
        id: typed(&value["id"])?,
        kind,
    })
}

fn control_input(value: &Value) -> Result<StoredControlInput, CaseError> {
    Ok(StoredControlInput {
        content: typed(&value["content"])?,
        transcript_view_id: typed(&value["transcriptViewId"])?,
        created_at: typed(&value["createdAt"])?,
        receipt: optional(&value["receipt"], |value| {
            Ok(StoredControlReceipt {
                title: typed(&value["title"])?,
                content: typed(&value["content"])?,
                detail: parse_transcript_notice_detail(&value["detail"])
                    .map(Box::new)
                    .ok_or_else(|| CaseError::undeliverable("invalid receipt detail"))?,
            })
        })?,
    })
}

fn control(value: &Value) -> Result<StoredChatExecutionControlState, CaseError> {
    Ok(StoredChatExecutionControlState {
        server_instance_id: typed(&value["serverInstanceId"])?,
        entries: list(&value["entries"], stored_entry)?,
        control_entries: list(&value["controlEntries"], |entry| {
            Ok(StoredControlInputEntry {
                id: typed(&entry["id"])?,
                input: control_input(entry)?,
            })
        })?,
        recently_dispatched: list(&value["recentlyDispatched"], |entry| {
            Ok(RecentlyDispatchedQueueEntry {
                entry_id: typed(&entry["entryId"])?,
                revision: typed(&entry["revision"])?,
                dispatched_at: typed(&entry["dispatchedAt"])?,
            })
        })?,
        applied_commands: list(&value["appliedCommands"], |entry| {
            let operation = match entry["operation"].as_str() {
                Some("create") => StoredQueueCommandOperation::Create,
                Some("replace") => StoredQueueCommandOperation::Replace,
                Some("delete") => StoredQueueCommandOperation::Delete,
                Some("move") => StoredQueueCommandOperation::Move,
                _ => return Err(CaseError::undeliverable("invalid recorded queue operation")),
            };
            Ok(StoredAppliedQueueCommand {
                key: typed(&entry["key"])?,
                operation,
                entry_id: typed(&entry["entryId"])?,
                applied_at: typed(&entry["appliedAt"])?,
            })
        })?,
        pause: optional(&value["pause"], stored_pause)?,
        reorder_revision: typed(&value["reorderRevision"])?,
        version: typed(&value["version"])?,
        updated_at: typed(&value["updatedAt"])?,
        resume_pauses: optional(&value["resumePauses"], |pauses| list(pauses, stored_pause))?,
    })
}

#[test]
fn control_state_recordings() {
    replay(directory("control-state"), |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "emptyStoredChatExecutionControl" => {
                let id = text(function, args.first())?
                    .ok_or_else(|| CaseError::undeliverable("missing server instance ID"))?;
                serialized(empty_stored_chat_execution_control(id))
            }
            "queuedAttachmentBytes" => serialized(queued_attachment_bytes(&images(&value)?)),
            "queueEntryAttachments" => serialized(queue_entry_attachments(&images(&value)?)),
            "cloneStoredQueueEntry" => serialized(clone_stored_queue_entry(&stored_entry(&value)?)),
            "toClientQueueEntry" => serialized(to_client_queue_entry(&stored_entry(&value)?)),
            "cloneStoredChatExecutionControl" => {
                serialized(clone_stored_chat_execution_control(&control(&value)?))
            }
            "hasPendingTurnInput" => json!(has_pending_turn_input(&control(&value)?)),
            "toClientChatExecutionControlState" => {
                serialized(to_client_chat_execution_control_state(&control(&value)?))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn transition_recordings() {
    replay(directory("control-transitions"), |function, args| {
        if function != "replayControlTransition" {
            return Err(CaseError::unhandled(function));
        }
        let name = text(function, args.first())?
            .ok_or_else(|| CaseError::undeliverable("missing transition name"))?;
        let inputs = unknown(function, args.get(1))?;
        let state = control(&inputs[0])?;
        let input = &inputs[1];
        let now = text(function, args.get(2))?
            .ok_or_else(|| CaseError::undeliverable("missing transition time"))?;
        let ids: Vec<String> = typed(unknown(function, args.get(3))?.as_ref())?;
        let receipts: Vec<HashSet<String>> = typed(unknown(function, args.get(4))?.as_ref())?;
        let id_calls = Cell::new(0);
        let receipt_lookups = Cell::new(0);
        let context = TransitionContext {
            now,
            new_id: &|| {
                let index = id_calls.get();
                id_calls.set(index + 1);
                ids.get(index)
                    .cloned()
                    .unwrap_or_else(|| "unexpected-id".into())
            },
            unsettled_queue_receipt_keys: &|| {
                let index = receipt_lookups.get();
                receipt_lookups.set(index + 1);
                receipts.get(index).cloned().unwrap_or_default()
            },
        };
        let transition = match name {
            "createQueueEntry" => serialized(create_queue_entry(
                &state,
                &QueueEntryInput {
                    content: typed(&input["content"])?,
                    images: images(&input["images"])?,
                    command: typed(&input["command"])?,
                    submission: optional(&input["submission"], submission)?,
                },
                &context,
            )),
            "createQueuedSteer" => serialized(create_queued_steer(
                &state,
                &QueuedSteerInput {
                    content: typed(&input["content"])?,
                    command: typed(&input["command"])?,
                    submission: optional(&input["submission"], submission)?,
                },
                &context,
            )),
            "enqueueControlInput" => serialized(enqueue_control_input(
                &state,
                &control_input(input)?,
                &context,
            )),
            "replaceQueueEntry" => serialized(replace_queue_entry(
                &state,
                &ReplaceQueueEntryInput {
                    entry_id: typed(&input["entryId"])?,
                    content: typed(&input["content"])?,
                    expected_revision: typed(&input["expectedRevision"])?,
                    command: typed(&input["command"])?,
                },
                &context,
            )),
            "deleteQueueEntry" => serialized(delete_queue_entry(
                &state,
                &DeleteQueueEntryInput {
                    entry_id: typed(&input["entryId"])?,
                    command: typed(&input["command"])?,
                },
                &context,
            )),
            "moveQueueEntry" => serialized(move_queue_entry(
                &state,
                &MoveQueueEntryInput {
                    entry_id: typed(&input["entryId"])?,
                    target_entry_id: typed(&input["targetEntryId"])?,
                    placement: match input["placement"].as_str() {
                        Some("before") => QueueEntryPlacement::Before,
                        Some("after") => QueueEntryPlacement::After,
                        _ => return Err(CaseError::undeliverable("invalid queue placement")),
                    },
                    expected_reorder_revision: typed(&input["expectedReorderRevision"])?,
                    expected_source_revision: typed(&input["expectedSourceRevision"])?,
                    expected_target_revision: typed(&input["expectedTargetRevision"])?,
                    command: typed(&input["command"])?,
                },
                &context,
            )),
            "clearQueue" => serialized(clear_queue(&state, &context)),
            "discardPendingInput" => serialized(discard_pending_input(&state, &context)),
            "pauseQueue" => serialized(pause_queue(&state, &context)),
            "resumeQueue" => serialized(resume_queue(&state, &typed::<String>(input)?, &context)),
            "dequeueNextTurn" => serialized(dequeue_next_turn(&state, &context)),
            "reserveQueueSteer" => {
                serialized(reserve_queue_steer(&state, &typed(input)?, &context))
            }
            "reservePendingSteer" => {
                serialized(reserve_pending_steer(&state, &typed(input)?, &context))
            }
            "markQueueEntrySteer" => {
                serialized(mark_queue_entry_steer(&state, &typed(input)?, &context))
            }
            "releaseQueueSteer" => serialized(release_queue_steer(
                &state,
                &typed::<String>(input)?,
                &context,
            )),
            "consumeQueueSteer" => serialized(consume_queue_steer(
                &state,
                &typed::<String>(input)?,
                &context,
            )),
            "requeueAndPause" => serialized(requeue_and_pause(
                &state,
                &RequeueAndPauseInput {
                    entry_id: typed(&input["entryId"])?,
                    kind: match input["kind"].as_str() {
                        Some("queued-turn-failed") => AutomaticQueuePauseKind::QueuedTurnFailed,
                        Some("completion-uncertain") => {
                            AutomaticQueuePauseKind::CompletionUncertain
                        }
                        _ => return Err(CaseError::undeliverable("invalid automatic pause kind")),
                    },
                },
                &context,
            )),
            "pauseAfterFailure" => {
                serialized(pause_after_failure(&state, &typed(input)?, &context))
            }
            _ => return Err(CaseError::unhandled(name)),
        };
        Ok(json!({
            "transition": transition,
            "idCalls": id_calls.get(),
            "receiptLookups": receipt_lookups.get(),
        }))
    });
}
