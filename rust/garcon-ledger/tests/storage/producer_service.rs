use std::{cell::RefCell, future::ready, path::Path, process::Command, rc::Rc};

use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_transient_feed::ChatTransientControlAction,
    chat_types::{AssistantMessage, ChatMessage, UserMessage},
};
use garcon_interface::producer::{
    AgentEstablishedSession, AgentFinalResponse, AgentProducedRow, AgentProducerEvent,
    AgentRunOutcome,
};
use garcon_js::{clock::ManualClock, date_parse::date_parse};
use garcon_ledger::{
    codec::StoredLedgerRow,
    contracts::transcript_view_id,
    errors::{LedgerError, TranscriptSinkClosedError},
    garcon_command_publication::GarconCommandDispatch,
    input_submission::input_detail,
    service::{
        AppendInput, PermissionActionability, TranscriptCommitEvent, TranscriptCommitWork,
        TranscriptLedgerService, TranscriptLedgerServiceOptions,
    },
    store::{StageViewInput, TranscriptWatermark},
};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::task::LocalSet;

use super::bulk_views::{initialize, store};

const AT: &str = "2026-11-28T09:00:00.000Z";
const CHAT: &str = "producer-service";
const VIEW: &str = "service-view";
const RUN: &str = "synthetic-run";
const INSTANCE: &str = "synthetic-server";
const OWNER: &str = "synthetic-owner";
const OCCURRENCE: &str = "11111111-1111-4111-8111-111111111111";
const LATE_OCCURRENCE: &str = "22222222-2222-4222-8222-222222222222";

fn permission(occurrence: &str, decision_occurrence: &str) -> AgentProducerEvent {
    serde_json::from_value(json!({
        "type": "permission", "runId": RUN,
        "lifecycle": {
            "kind": "requested", "permissionOccurrenceId": occurrence,
            "requestedTool": {
                "type": "bash-tool-use", "timestamp": AT, "toolId": "synthetic-tool", "command": "true",
            },
            "options": [{"id":"allow","label":"Allow"}],
        },
        "decision": {"permissionOccurrenceId": decision_occurrence, "response": {
            "executorId":"local", "instanceId":"synthetic-executor", "integrationId":OWNER,
            "kind":"permission-response", "id":"synthetic-response",
        }}
    })).unwrap()
}

fn control(occurrence: &str) -> ChatTransientControlAction {
    ChatTransientControlAction {
        chat_id: CHAT.into(),
        run_id: RUN.into(),
        server_instance_id: INSTANCE.into(),
        permission_occurrence_id: occurrence.into(),
    }
}

fn rows(content: &str) -> AgentProducerEvent {
    AgentProducerEvent::Rows {
        rows: vec![AgentProducedRow {
            message: ChatMessage::Assistant(AssistantMessage {
                timestamp: AT.into(),
                content: content.into(),
                questions: None,
            }),
            provider_meta: None,
        }],
    }
}

fn summarize(event: &TranscriptCommitEvent) -> Value {
    match event {
        TranscriptCommitEvent::Rows { rows, .. } => json!({
            "type":"rows", "ordinals": rows.iter().map(|row| row.ordinal).collect::<Vec<_>>(),
        }),
        TranscriptCommitEvent::Permission { row, run_id, .. } => json!({
            "type":"permission", "ordinal":row.ordinal, "runId":run_id,
        }),
        TranscriptCommitEvent::RunEnded {
            row,
            run_id,
            final_response,
            ..
        } => json!({
            "type":"run-ended", "ordinal":row.ordinal, "runId":run_id, "finalResponse":final_response,
        }),
        TranscriptCommitEvent::Session { row, .. } => {
            json!({"type":"session","ordinal":row.ordinal})
        }
        unexpected => panic!("Unexpected event: {unexpected:?}"),
    }
}

async fn native_fixture(root: &Path, write: bool) -> Value {
    LocalSet::new().run_until(async {
        let store = store(root);
        let synchronous = Rc::new(RefCell::new(Vec::new()));
        let published = Rc::new(RefCell::new(Vec::new()));
        if write {
            initialize(&store, CHAT, VIEW, &[]);
            let commands = synchronous.clone();
            let command_store = store.clone();
            let service = Rc::new(TranscriptLedgerService::new(store.clone(), TranscriptLedgerServiceOptions {
                clock: Some(Rc::new(ManualClock::new(date_parse(AT).unwrap()))),
                server_instance_id: Some(INSTANCE.into()),
                command_sink: Some(Rc::new(move |event| {
                    let GarconCommandDispatch::ChatIdRequest { chat_id, run_id, .. } = event else {
                        panic!("Unexpected command in fixture")
                    };
                    commands.borrow_mut().push(json!({
                        "type":"chat-id", "runId":run_id,
                        "ordinal":command_store.high_watermark(chat_id)?.ordinal,
                    }));
                    Ok(())
                })),
                ..Default::default()
            }));
            let session = synchronous.clone();
            let _session = service.subscribe_session_committed(Rc::new(move |event| {
                session.borrow_mut().push(json!({"type":"session","ordinal":event.row.ordinal}));
                Ok(())
            }));
            let terminals = synchronous.clone();
            let terminal_store = store.clone();
            let _terminal = service.subscribe_run_ended_committed(Rc::new(move |event| {
                terminals.borrow_mut().push(json!({
                    "type":"run-ended", "runId":event.run_id,
                    "ordinal":terminal_store.high_watermark(&event.chat_id)?.ordinal,
                }));
                Ok(())
            }));
            let actions = synchronous.clone();
            let _action = service.subscribe_permission_actionability_changed(Rc::new(move |event| {
                let kind = match event.actionability {
                    PermissionActionability::Claimed => "claimed",
                    PermissionActionability::Actionable => "actionable",
                };
                actions.borrow_mut().push(json!({"type":kind,"id":event.control.permission_occurrence_id}));
                Ok(())
            }));
            let commits = published.clone();
            let _commits = service.subscribe(Rc::new(move |event| {
                commits.borrow_mut().push(summarize(&event));
                TranscriptCommitWork::Complete(Ok(()))
            }));
            let lease = service.open_producer(CHAT, OWNER).unwrap();
            let sink = lease.sink();
            service.begin_run(CHAT, Some(RUN)).unwrap();
            sink.publish(AgentProducerEvent::Session { session: AgentEstablishedSession {
                agent_session_id: "synthetic-session".into(), native_session: None, native_seed_receipt: None,
            }}).unwrap();
            sink.publish(rows("<garcon-get-chat-id />\nSynthetic answer.")).unwrap();
            sink.publish(permission(OCCURRENCE, OCCURRENCE)).unwrap();
            let first = service.claim_permission_resolution(&control(OCCURRENCE)).unwrap();
            service.abandon_permission_resolution(&first).unwrap();
            let second = service.claim_permission_resolution(&control(OCCURRENCE)).unwrap();
            service.complete_permission_resolution(&second, PermissionDecisionPayload { allow: true, always_allow: None, response: None }).unwrap();
            sink.publish(AgentProducerEvent::Notice { run_id: RUN.into(), content: "Synthetic advisory".into(), title: None }).unwrap();
            sink.publish(AgentProducerEvent::RunEnded {
                run_id: RUN.into(), outcome: AgentRunOutcome::Finished {
                    final_response: Some(AgentFinalResponse::Text { text: "<garcon-get-chat-id />\nSynthetic terminal.".into() }),
                }, working_directory: None,
            }).unwrap();
            assert!(!service.is_run_active(CHAT, None));
            sink.publish(AgentProducerEvent::RunEnded {
                run_id: RUN.into(), outcome: AgentRunOutcome::Finished { final_response: None }, working_directory: None,
            }).unwrap();
            sink.publish(rows("Synthetic late row")).unwrap();
            sink.publish(permission(LATE_OCCURRENCE, LATE_OCCURRENCE)).unwrap();
            assert!(matches!(service.claim_permission_resolution(&control(LATE_OCCURRENCE)).unwrap_err().downcast_ref(),
                Some(LedgerError::PermissionNotActionable)));
            assert!(published.borrow().is_empty());
            garcon_base::event_loop::yield_to_event_loop().await;
            assert_eq!(store.high_watermark(CHAT).unwrap().ordinal, 9);
            assert_eq!(published.borrow().len(), 8);
            service.close().unwrap();
            assert!(sink.publish(rows("after close")).unwrap_err().is::<TranscriptSinkClosedError>());
        }
        let head = store.high_watermark(CHAT).unwrap();
        let rows = store.with_stored_rows_through(CHAT, &head, |rows| ready(Ok(rows)), None).await.unwrap();
        store.close().unwrap();
        #[derive(Serialize)]
        struct Stored { head: TranscriptWatermark, rows: Vec<StoredLedgerRow> }
        let stored = serde_json::to_string(&Stored { head, rows }).unwrap();
        json!({"stored":stored, "synchronous": *synchronous.borrow(), "published": *published.borrow()})
    }).await
}

fn bun(root: &Path, mode: &str) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/producer-service-oracle.ts"
        ))
        .arg(mode)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn tlv5_l03_01_core_unit_01_commits_producer_events_synchronously_and_notifies_after_publish_returns()
 {
    let original = tempfile::tempdir().unwrap();
    let expected = bun(original.path(), "write");
    assert_eq!(
        native_fixture(original.path(), false).await["stored"],
        expected["stored"]
    );
    let native = tempfile::tempdir().unwrap();
    assert_eq!(native_fixture(native.path(), true).await, expected);
    assert_eq!(bun(native.path(), "read")["stored"], expected["stored"]);
}

#[tokio::test]
async fn stale_capabilities_and_prepared_input_cannot_cross_view_replacement() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            let view = transcript_view_id(VIEW).unwrap();
            let replacement = transcript_view_id("replacement").unwrap();
            initialize(&store, CHAT, VIEW, &[]);
            let service = Rc::new(TranscriptLedgerService::new(
                store.clone(),
                TranscriptLedgerServiceOptions {
                    clock: Some(Rc::new(ManualClock::new(date_parse(AT).unwrap()))),
                    server_instance_id: Some(INSTANCE.into()),
                    ..Default::default()
                },
            ));
            let detail = input_detail(
                UserMessage {
                    timestamp: AT.into(),
                    content: "Synthetic prompt".into(),
                    images: None,
                    metadata: None,
                    presentation: None,
                },
                Vec::new(),
                Some("input-id".into()),
                false,
            );
            let append = || AppendInput {
                view_id: &view,
                detail: &detail,
                excluded_ordinals: None,
                preamble_boundary: None,
                preambles: &[],
            };
            let accepted = service.append_input_and_compose(CHAT, append()).unwrap();
            assert!(accepted.inserted);
            assert!(
                !service
                    .append_input_and_compose(CHAT, append())
                    .unwrap()
                    .inserted
            );
            assert!(Rc::ptr_eq(
                &accepted,
                &service.take_prepared_input(CHAT, Some("input-id")).unwrap()
            ));
            let mut next_detail = detail.clone();
            next_detail.client_message_id = Some("next-input-id".into());
            service
                .append_input_and_compose(
                    CHAT,
                    AppendInput {
                        detail: &next_detail,
                        ..append()
                    },
                )
                .unwrap();
            let sink = service.open_producer(CHAT, OWNER).unwrap().sink();
            service.begin_run(CHAT, Some(RUN)).unwrap();
            let before = store.high_watermark(CHAT).unwrap().ordinal;
            assert!(
                sink.publish(permission(OCCURRENCE, LATE_OCCURRENCE))
                    .is_err()
            );
            assert_eq!(store.high_watermark(CHAT).unwrap().ordinal, before);
            sink.publish(permission(OCCURRENCE, OCCURRENCE)).unwrap();
            let claim = service
                .claim_permission_resolution(&control(OCCURRENCE))
                .unwrap();
            let decision = || PermissionDecisionPayload {
                allow: true,
                always_allow: None,
                response: None,
            };
            let counterfeit = Rc::new((*claim).clone());
            assert!(matches!(
                service
                    .complete_permission_resolution(&counterfeit, decision())
                    .unwrap_err()
                    .downcast_ref(),
                Some(LedgerError::PermissionNotActionable)
            ));
            store
                .stage_view(
                    CHAT,
                    StageViewInput {
                        view_id: replacement.clone(),
                        content_start_ordinal: 1,
                        rows: &[],
                    },
                )
                .await
                .unwrap();
            service
                .replace_current_view(CHAT, &view, &replacement)
                .unwrap();
            assert!(
                service
                    .take_prepared_input(CHAT, Some("next-input-id"))
                    .is_none()
            );
            assert!(!service.is_run_active(CHAT, None));
            assert!(
                sink.publish(rows("old sink"))
                    .unwrap_err()
                    .is::<TranscriptSinkClosedError>()
            );
            assert!(matches!(
                service
                    .complete_permission_resolution(&claim, decision())
                    .unwrap_err()
                    .downcast_ref(),
                Some(LedgerError::PermissionNotActionable)
            ));
            let new_sink = service.open_producer(CHAT, OWNER).unwrap().sink();
            new_sink.publish(rows("new sink")).unwrap();
            assert_eq!(store.high_watermark(CHAT).unwrap().ordinal, 1);
            service.close().unwrap();
        })
        .await;
}

#[tokio::test]
async fn retires_permission_controls_after_their_committed_request_and_before_an_unpersisted_failure()
 {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            initialize(&store, CHAT, VIEW, &[]);
            let service = Rc::new(TranscriptLedgerService::new(
                store.clone(),
                TranscriptLedgerServiceOptions {
                    clock: Some(Rc::new(ManualClock::new(date_parse(AT).unwrap()))),
                    ..Default::default()
                },
            ));
            let order = Rc::new(RefCell::new(Vec::new()));
            let commits = order.clone();
            let _commits = service.subscribe(Rc::new(move |event| {
                assert!(matches!(&*event, TranscriptCommitEvent::Permission { .. }));
                commits.borrow_mut().push("permission");
                TranscriptCommitWork::Complete(Ok(()))
            }));
            let retired = order.clone();
            let _retired = service.subscribe_permission_retired(Rc::new(move |control| {
                assert_eq!(control.permission_occurrence_id, OCCURRENCE);
                retired.borrow_mut().push("retired");
                Ok(())
            }));
            let abandoned = order.clone();
            let _abandoned = service.subscribe_run_abandoned(Rc::new(move |run| {
                assert_eq!(run.run_id, RUN);
                abandoned.borrow_mut().push("abandoned");
                TranscriptCommitWork::Complete(Ok(()))
            }));
            let lease = service.open_producer(CHAT, OWNER).unwrap();
            service.begin_run(CHAT, Some(RUN)).unwrap();
            lease
                .sink()
                .publish(permission(OCCURRENCE, OCCURRENCE))
                .unwrap();
            let db = Connection::open(root.path().join(CHAT).join("ledger.sqlite")).unwrap();
            db.execute_batch(
                "CREATE TRIGGER abort_terminal BEFORE INSERT ON transcript_rows
                 WHEN NEW.kind = 'run-ended' BEGIN
                   SELECT RAISE(ABORT, 'synthetic terminal failure');
                 END",
            )
            .unwrap();
            assert!(matches!(
                service.interrupt_run(CHAT).unwrap_err().downcast_ref(),
                Some(LedgerError::Fenced { .. })
            ));
            assert!(lease.closed());
            assert!(!service.is_run_active(CHAT, None));
            assert!(order.borrow().is_empty());
            assert_eq!(store.high_watermark(CHAT).unwrap().ordinal, 1);
            garcon_base::event_loop::yield_to_event_loop().await;
            assert_eq!(*order.borrow(), ["permission", "retired", "abandoned"]);
            service.close().unwrap();
        })
        .await;
}
