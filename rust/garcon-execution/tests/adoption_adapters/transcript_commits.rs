use std::{cell::RefCell, rc::Rc, time::Duration};

use garcon_base::event_loop::yield_to_event_loop;
use garcon_execution::{
    command_ledger::{CommandLedger, CommandLedgerOptions, CommandTurnResult, LedgerAcceptInput},
    event_bus::TurnEventMetadata,
    listener_dispatch::ListenerWork,
};
use garcon_interface::producer::{AgentFinalResponse, AgentProducerEvent, AgentRunOutcome};
use garcon_js::{clock::SystemClock, json::Opaque};
use garcon_ledger::{
    contracts::transcript_view_id,
    service::{TranscriptCommitEvent, TranscriptLedgerService},
    store::{InitializeViewInput, TranscriptLedgerStore},
};
use serde_json::Value;
use tokio::{
    sync::{Notify, oneshot},
    task::LocalSet,
};

use super::{
    AgentDirectory, AgentRegistry, AgentRegistryOptions, AgentRuntimeRouterOptions, Effects,
    IdleFacets, SourceDirectory, create_logger, install_unhandled_rejection_policy,
};

const CHAT: &str = "1767225600000000";
const RUN: &str = "synthetic-run";

#[tokio::test]
async fn committed_terminal_waits_for_transcript_fanout_and_command_result() {
    LocalSet::new().run_until(tokio::time::timeout(Duration::from_secs(5), async {
        let root = tempfile::tempdir().unwrap();
        let store = Rc::new(TranscriptLedgerStore::new(root.path().to_str().unwrap(), Default::default()).unwrap());
        store.initialize_current_view(CHAT, InitializeViewInput {
            view_id: Some(transcript_view_id("synthetic-view").unwrap()), content_start_ordinal: 1, rows: &[],
        }).unwrap();
        let ledger = Rc::new(TranscriptLedgerService::new(store, Default::default()));
        let directory = Rc::new(AgentDirectory::new(Rc::new(SourceDirectory { integration: None, effects: Effects::default() })));
        let logger = Rc::new(create_logger("test"));
        let registry = Rc::new(AgentRegistry::new(AgentRegistryOptions {
            runtime: AgentRuntimeRouterOptions {
                registry: Rc::new(IdleFacets), directory: directory.clone(), ledger: Rc::new(IdleFacets),
                unhandled_rejections: Rc::new(install_unhandled_rejection_policy(logger.clone())),
            }, directory, get_carry_over_revision: Rc::new(|_| String::new()), logger,
        }));
        let commands = Rc::new(CommandLedger::new(CommandLedgerOptions::default(), Rc::new(SystemClock)).unwrap());
        commands.accept(&LedgerAcceptInput {
            command_type: "agent-run".into(), chat_id: CHAT.into(), client_request_id: "synthetic-request".into(),
            payload: Opaque::from_value(Value::Null), turn_id: Some(RUN.into()), entry_id: None,
        }).await.unwrap();
        registry.events().track_turn(CHAT, &TurnEventMetadata { turn_id: Some(RUN.into()), ..Default::default() }).unwrap();
        let trace = Rc::new(RefCell::new(Vec::new()));
        let started = Rc::new(Notify::new());
        let finished = Rc::new(Notify::new());
        let (release, barrier) = oneshot::channel();
        let barrier = RefCell::new(Some(barrier));
        registry.on_transcript_committed(Rc::new({
            let (trace, started) = (trace.clone(), started.clone());
            move |event| {
                assert!(matches!(event, TranscriptCommitEvent::RunEnded { .. }));
                trace.borrow_mut().push("fanout-entered");
                started.notify_one();
                let gate = barrier.take().unwrap();
                let trace = trace.clone();
                ListenerWork::Pending(Box::pin(async move {
                    gate.await?;
                    trace.borrow_mut().push("chat-messages");
                    Ok(())
                }))
            }
        }));
        registry.on_transcript_committed(Rc::new({
            let trace = trace.clone();
            move |_| { trace.borrow_mut().push("next-transcript-listener"); ListenerWork::Synchronous(Ok(())) }
        }));
        registry.events().on_finished(Rc::new({
            let (trace, finished, commands) = (trace.clone(), finished.clone(), commands.clone());
            move |chat, _, _, _| {
                let (trace, finished, commands) = (trace.clone(), finished.clone(), commands.clone());
                ListenerWork::Pending(Box::pin(async move {
                    let record = commands.get_turn_record(chat, RUN).await.unwrap();
                    assert!(matches!(record.turn_result(), Some(CommandTurnResult::Available { text, .. }) if text == "synthetic answer"));
                    trace.borrow_mut().push("agent-run-finished");
                    finished.notify_one();
                    Ok(())
                }))
            }
        }));
        let off = registry.bind_transcript_commits(&ledger, commands.clone());
        let off_terminal = ledger.subscribe_run_ended_committed(Rc::new({
            let trace = trace.clone();
            move |_| { trace.borrow_mut().push("terminal-marked"); Ok(()) }
        }));

        let lease = ledger.open_producer(CHAT, "test").unwrap();
        ledger.begin_run(CHAT, Some(RUN)).unwrap();
        lease.sink().publish(AgentProducerEvent::RunEnded {
            run_id: RUN.into(), outcome: AgentRunOutcome::Finished {
                final_response: Some(AgentFinalResponse::Text { text: "synthetic answer".into() }),
            }, working_directory: None,
        }).unwrap();
        assert_eq!(*trace.borrow(), ["terminal-marked"]);
        started.notified().await;
        yield_to_event_loop().await;
        assert_eq!(*trace.borrow(), ["terminal-marked", "fanout-entered"]);
        assert!(commands.get_turn_record(CHAT, RUN).await.unwrap().turn_result().is_none());
        release.send(()).unwrap();
        finished.notified().await;
        assert_eq!(*trace.borrow(), ["terminal-marked", "fanout-entered", "chat-messages", "next-transcript-listener", "agent-run-finished"]);
        off();
        off_terminal();
        ledger.close().unwrap();
    })).await.unwrap();
}
