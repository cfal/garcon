use std::cell::{Cell, RefCell};

use garcon_cases::{CaseError, replay, text};
use garcon_contract::project_resolution::ProjectUnavailableReason;
use garcon_ledger::contracts::transcript_view_id;
use serde_json::{Value, json};

use crate::turn_terminal_settlement::{ProducerLeaseState, TurnExecutionSnapshot};

use super::*;

const CHAT: &str = "1767225600000000";
const EXECUTOR: &str = "11111111-1111-4111-8111-111111111111";

#[derive(Default)]
struct Lease(Cell<bool>);

impl ProducerLeaseState for Lease {
    fn closed(&self) -> bool {
        self.0.get()
    }
}

struct Fake {
    change: String,
    calls: RefCell<Vec<Value>>,
    chat: RefCell<WorkingDirectoryBinding>,
    view: Cell<&'static str>,
    lease: Rc<Lease>,
    current: Cell<bool>,
}

#[async_trait(?Send)]
impl WorkingDirectoryPorts for Fake {
    fn get_chat(&self, _: &str) -> Option<WorkingDirectoryBinding> {
        let chat = self.chat.borrow();
        Some(WorkingDirectoryBinding {
            agent_id: chat.agent_id.clone(),
            executor_id: chat.executor_id.clone(),
            epoch: chat.epoch.clone(),
            project_path: chat.project_path.clone(),
        })
    }

    fn existing_view_id(&self, _: &str) -> ExecutionOperationResult<Option<TranscriptViewId>> {
        Ok(Some(transcript_view_id(self.view.get())?))
    }

    async fn inspect(
        &self,
        path: &str,
        executor: &str,
        options: ExecutorCallOptions,
    ) -> ExecutionOperationResult<ProjectResolution> {
        self.calls
            .borrow_mut()
            .push(json!(["inspect", path, executor, {
            "liveSignal": options.signal.as_ref().is_some_and(|signal| !signal.is_cancelled()),
                "timeoutMs": options.timeout_ms, "dispatchDeadline": options.dispatch_deadline,
            }]));
        tokio::task::yield_now().await;
        match self.change.as_str() {
            "inspect-owner" => self.chat.borrow_mut().epoch = "epoch-2".into(),
            "inspect-path" => self.chat.borrow_mut().project_path = "/replacement".into(),
            "inspect-agent" => self.chat.borrow_mut().agent_id = "other".into(),
            "inspect-executor" => self.chat.borrow_mut().executor_id = Some("local".into()),
            "inspect-attempt" => self.current.set(false),
            "inspect-lease" => self.lease.0.set(true),
            "inspect-view" => self.view.set("view-2"),
            "inspect-failed" => return Err("Synthetic inspection failure".into()),
            "inspect-timeout" => {
                options.signal.unwrap().cancelled().await;
                return Err("Synthetic inspection timeout".into());
            }
            "unavailable" => {
                return Ok(ProjectResolution::Unavailable {
                    reason: ProjectUnavailableReason::OutsideBase,
                });
            }
            _ => {}
        }
        Ok(ProjectResolution::Available {
            effective_project_key: path.into(),
        })
    }

    async fn update_observed_path(
        &self,
        chat_id: &str,
        update: ChatProjectPathUpdatedPayload,
    ) -> ExecutionOperationResult<bool> {
        self.calls
            .borrow_mut()
            .push(json!(["update", chat_id, update]));
        tokio::task::yield_now().await;
        match self.change.as_str() {
            "write-failed" => return Err("Synthetic disk failure".into()),
            "write-unknown" => return Ok(false),
            "write-owner" => self.chat.borrow_mut().epoch = "epoch-2".into(),
            "write-view" => self.view.set("view-2"),
            "write-attempt" => self.current.set(false),
            "write-lease" => self.lease.0.set(true),
            _ => self.chat.borrow_mut().project_path = update.project_path,
        }
        Ok(!self.change.starts_with("write-"))
    }

    fn append_failure_notice(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        title: &str,
        content: &str,
    ) -> ExecutionOperationResult<()> {
        self.calls
            .borrow_mut()
            .push(json!(["notice", chat_id, view_id, title, content]));
        Ok(())
    }
}

async fn trace(change: &str) -> Value {
    let lease = Rc::new(Lease::default());
    let ports = Rc::new(Fake {
        change: change.into(),
        calls: RefCell::new(Vec::new()),
        chat: RefCell::new(WorkingDirectoryBinding {
            agent_id: "synthetic".into(),
            executor_id: Some(EXECUTOR.into()),
            epoch: if change == "stale" {
                "epoch-2".into()
            } else {
                "epoch-1".into()
            },
            project_path: "/project".into(),
        }),
        view: Cell::new("view-1"),
        lease: lease.clone(),
        current: Cell::new(true),
    });
    let settler = WorkingDirectorySettler::new(ports.clone(), Rc::default());
    let turn = TurnEventMetadata {
        agent_ownership_epoch: Some("epoch-1".into()),
        working_directory: Some(match change {
            "not-reported" => CommandWorkingDirectory::Unavailable {
                reason: "exit".into(),
            },
            "unchanged" => CommandWorkingDirectory::Reported {
                path: "/project".into(),
            },
            _ => CommandWorkingDirectory::Reported {
                path: "/project/ next\n".into(),
            },
        }),
        execution_snapshot: Some(TurnExecutionSnapshot {
            agent_id: "synthetic".into(),
            executor_id: EXECUTOR.into(),
            project_path: "/project".into(),
            transcript_view_id: "view-1".into(),
            producer_lease: lease,
        }),
        ..Default::default()
    };
    let result = settler
        .settle(CHAT, &turn, &|| ports.current.get())
        .await
        .unwrap();
    json!({"result": result, "path": ports.chat.borrow().project_path, "calls": &*ports.calls.borrow()})
}

#[test]
fn working_directory_settlement_matches_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/working-directory-settlement"
        ),
        |function, args| {
            if function != "workingDirectorySettlementTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing scenario"))?;
            Ok(runtime.block_on(trace(scenario)))
        },
    );
}

#[tokio::test(start_paused = true)]
async fn signals_a_slow_inspector_without_skipping_failure_settlement() {
    let start = tokio::time::Instant::now();
    let result = trace("inspect-timeout").await;
    assert_eq!(start.elapsed(), INSPECT_TIMEOUT);
    assert_eq!(result["result"]["kind"], "failed");
    assert_eq!(result["calls"][1][0], "notice");
    assert_eq!(result["calls"][1][4], result["result"]["message"]);
}
