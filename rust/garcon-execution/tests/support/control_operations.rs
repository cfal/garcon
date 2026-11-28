use std::{cell::RefCell, error::Error, future, rc::Rc, time::Duration};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError,
    errors::{ErrorInput, diagnostic_error_code},
    keyed_lock::KeyedLock,
};
use garcon_contract::{error_codes::ErrorCode, project_resolution::ProjectUnavailableReason};
use garcon_execution::{
    chat_execution_control_operations::*,
    chat_execution_control_repository::{
        ChatExecutionControlRepository, InMemoryChatExecutionControlRepository,
    },
    types::{
        ControlTransitionError, ExecutionOperationResult, ProjectAdmissionPort,
        QueuedAttachmentAdmissionPort, execution_error_input,
    },
};
use garcon_js::clock::ManualClock;

use super::*;

struct TestPorts {
    repository: Rc<InMemoryChatExecutionControlRepository>,
    exists: Cell<bool>,
    project_available: Cell<bool>,
    attachment_supported: Cell<bool>,
    publish_works: Cell<bool>,
    effects: RefCell<Vec<Value>>,
}

impl TestPorts {
    fn record(&self, effect: Value) {
        self.effects.borrow_mut().push(effect);
    }
}

impl ChatExecutionControlOperationsHost for TestPorts {
    fn chat_exists(&self, chat: &str) -> bool {
        self.record(json!(["exists", chat]));
        self.exists.get()
    }

    fn unsettled_queue_receipt_keys(&self, chat: &str) -> HashSet<String> {
        self.record(json!(["receipt-keys", chat]));
        HashSet::new()
    }

    fn publish(
        &self,
        chat: &str,
        control: &StoredChatExecutionControlState,
    ) -> ExecutionOperationResult<()> {
        self.record(json!([
            "publish",
            chat,
            control.version,
            self.repository.load(chat).version
        ]));
        if !self.publish_works.get() {
            return Err(Box::new(std::io::Error::other("listener failed")));
        }
        Ok(())
    }

    fn input_accepted(&self, chat: &str) -> ExecutionOperationResult<()> {
        self.record(json!(["accepted", chat]));
        Ok(())
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for TestPorts {
    async fn assert_available(
        &self,
        chat: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<()> {
        self.record(json!(["project", chat, deadline]));
        if !self.project_available.get() {
            return Err(Box::new(DomainError::new_project_unavailable(
                "/workspace/missing",
                ProjectUnavailableReason::NotFound,
            )));
        }
        Ok(())
    }
}

impl QueuedAttachmentAdmissionPort for TestPorts {
    fn assert_supported(
        &self,
        chat: &str,
        images: &[AgentCommandImage],
    ) -> ExecutionOperationResult<()> {
        self.record(json!(["attachments", chat, images.len()]));
        if !self.attachment_supported.get() {
            return Err(Box::new(DomainError::new(
                ErrorCode::UNSUPPORTED_AGENT,
                "Attachments unsupported",
                422,
                false,
            )));
        }
        Ok(())
    }
}

struct Harness {
    operations: ChatExecutionControlOperations,
    ports: Rc<TestPorts>,
    lock: Rc<KeyedLock>,
    id_calls: Rc<Cell<usize>>,
}

impl Harness {
    fn new() -> Self {
        let repository = Rc::new(InMemoryChatExecutionControlRepository::new("server".into()));
        let ports = Rc::new(TestPorts {
            repository: Rc::clone(&repository),
            exists: Cell::new(true),
            project_available: Cell::new(true),
            attachment_supported: Cell::new(true),
            publish_works: Cell::new(true),
            effects: RefCell::new(Vec::new()),
        });
        let id_calls = Rc::new(Cell::new(0));
        let next_id = Rc::clone(&id_calls);
        let lock = Rc::new(KeyedLock::new());
        let operations = ChatExecutionControlOperations::new(
            repository,
            Rc::clone(&lock),
            ports.clone(),
            ports.clone(),
            ports.clone(),
            Rc::new(ManualClock::new(60_123)),
            move || {
                let next = next_id.get() + 1;
                next_id.set(next);
                format!("id-{next}")
            },
        );
        Self {
            operations,
            ports,
            lock,
            id_calls,
        }
    }
}

fn operation_result(value: ExecutionOperationResult<impl Serialize>) -> Value {
    match value {
        Ok(value) => serialized(value),
        Err(error) => operation_error(error.as_ref()),
    }
}

fn operation_error(error: &(dyn Error + 'static)) -> Value {
    if let Some(error) = error.downcast_ref::<ControlTransitionError>() {
        let control = match error {
            ControlTransitionError::Mutation(error) => Some(error.control.as_ref()),
            ControlTransitionError::Pause(error) => Some(error.control.as_ref()),
            ControlTransitionError::Domain(_) => None,
        };
        let domain = error.domain_error();
        let ErrorInput::Diagnostic(diagnostic) = execution_error_input(error) else {
            panic!("execution error metadata was erased")
        };
        return json!({"error":{
            "name":diagnostic.diagnostic_metadata().name,
            "message":domain.message,
            "code":domain.code.as_str(),
            "status":domain.status,
            "control": control.map(serialized),
        }});
    }
    if let Some(domain) = error.downcast_ref::<DomainError>() {
        return json!({"error":{
            "name":domain.kind.name(),"message":domain.message,"code":domain.code.as_str(),
            "status":domain.status,"control":null,
        }});
    }
    json!({"error":{"name":"Error","message":error.to_string(),"code":null,"status":null,"control":null}})
}

async fn trace(steps: &Value) -> Result<Value, CaseError> {
    let harness = Harness::new();
    let ops = &harness.operations;
    let ports = &harness.ports;
    let mut results = Vec::new();
    for step in steps
        .as_array()
        .ok_or_else(|| CaseError::undeliverable("expected operation steps"))?
    {
        let chat = step[1].as_str().unwrap_or_default();
        let arg = &step[2];
        results.push(match step[0].as_str().unwrap_or_default() {
            "exists" => {
                ports.exists.set(typed(&step[1])?);
                Value::Null
            }
            "projectAvailable" => {
                ports.project_available.set(typed(&step[1])?);
                Value::Null
            }
            "attachmentSupported" => {
                ports.attachment_supported.set(typed(&step[1])?);
                Value::Null
            }
            "publishWorks" => {
                ports.publish_works.set(typed(&step[1])?);
                Value::Null
            }
            "create" => operation_result(
                ops.create(
                    chat,
                    &QueueEntryInput {
                        content: typed(&arg["content"])?,
                        images: images(&arg["images"])?,
                        command: typed(&arg["command"])?,
                        submission: optional(&arg["submission"], submission)?,
                    },
                    typed(&step[3])?,
                )
                .await,
            ),
            "createSteer" => operation_result(
                ops.create_steer(
                    chat,
                    &typed::<String>(arg)?,
                    &typed(&step[3])?,
                    &submission(&step[4])?,
                )
                .await,
            ),
            "markSteer" => operation_result(ops.mark_steer(chat, &typed(arg)?).await),
            "move" => operation_result(
                ops.move_entry(
                    chat,
                    &MoveQueueEntryInput {
                        entry_id: typed(&arg["entryId"])?,
                        target_entry_id: typed(&arg["targetEntryId"])?,
                        placement: match arg["placement"].as_str() {
                            Some("before") => QueueEntryPlacement::Before,
                            Some("after") => QueueEntryPlacement::After,
                            _ => return Err(CaseError::undeliverable("invalid queue placement")),
                        },
                        expected_reorder_revision: typed(&arg["expectedReorderRevision"])?,
                        expected_source_revision: typed(&arg["expectedSourceRevision"])?,
                        expected_target_revision: typed(&arg["expectedTargetRevision"])?,
                        command: typed(&step[3])?,
                    },
                )
                .await,
            ),
            "replace" => operation_result(
                ops.replace(
                    chat,
                    &ReplaceQueueEntryInput {
                        entry_id: typed(arg)?,
                        content: typed(&step[3])?,
                        expected_revision: typed(&step[4])?,
                        command: typed(&step[5])?,
                    },
                )
                .await,
            ),
            "delete" => operation_result(
                ops.delete(
                    chat,
                    &DeleteQueueEntryInput {
                        entry_id: typed(arg)?,
                        command: typed(&step[3])?,
                    },
                )
                .await,
            ),
            "clear" => operation_result(ops.clear(chat).await),
            "discardPendingInput" => operation_result(ops.discard_pending_input(chat).await),
            "enqueueControl" => {
                operation_result(ops.enqueue_control(chat, &control_input(arg)?).await)
            }
            "pause" => operation_result(ops.pause(chat).await),
            "pauseForUnavailableProject" => {
                operation_result(ops.pause_for_unavailable_project(chat).await)
            }
            "resume" => operation_result(ops.resume(chat, &typed::<String>(arg)?).await),
            "reserveSteer" => operation_result(ops.reserve_steer(chat, &typed(arg)?).await),
            "reservePendingSteer" => {
                operation_result(ops.reserve_pending_steer(chat, &typed(arg)?).await)
            }
            "releaseSteer" => {
                operation_result(ops.release_steer(chat, &typed::<String>(arg)?).await)
            }
            "consumeSteer" => {
                operation_result(ops.consume_steer(chat, &typed::<String>(arg)?).await)
            }
            "dequeueNextTurn" => {
                let admission = if arg == "throw" {
                    None
                } else {
                    Some(typed(arg)?)
                };
                operation_result(
                    ops.dequeue_next_turn(chat, |input| {
                        let (kind, entry) = match input {
                            DequeuedTurnInput::User { entry } => ("user", &entry.id),
                            DequeuedTurnInput::Control { entry } => ("control", &entry.id),
                        };
                        ports.record(json!(["admit", chat, kind, entry]));
                        admission.ok_or_else(|| {
                            Box::new(std::io::Error::other("admission failed")) as Box<dyn Error>
                        })
                    })
                    .await,
                )
            }
            "requeueAndPause" => {
                let kind = match step[3].as_str() {
                    Some("queued-turn-failed") => AutomaticQueuePauseKind::QueuedTurnFailed,
                    Some("completion-uncertain") => AutomaticQueuePauseKind::CompletionUncertain,
                    _ => return Err(CaseError::undeliverable("invalid automatic pause kind")),
                };
                operation_result(
                    ops.requeue_and_pause(chat, &typed::<String>(arg)?, kind)
                        .await,
                )
            }
            "pauseAfterFailure" => {
                operation_result(ops.pause_after_failure(chat, &typed(arg)?).await)
            }
            "withControl" => {
                operation_result(ops.with_control(chat, |state| async { Ok(state) }).await)
            }
            "read" => operation_result(ops.read(chat).await),
            "deleteStored" => {
                ops.delete_stored(chat);
                Value::Null
            }
            name => return Err(CaseError::unhandled(name)),
        });
    }
    Ok(json!({
        "results": results,
        "effects": ports.effects.borrow().as_slice(),
        "idCalls": harness.id_calls.get(),
    }))
}

#[test]
fn control_operations_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    replay(directory("control-operations"), |function, args| {
        if function != "controlOperationsTrace" {
            return Err(CaseError::unhandled(function));
        }
        let steps = unknown(function, args.first())?;
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(2), trace(&steps))
                .await
                .map_err(|_| CaseError::undeliverable("operation trace timed out"))?
        })
    });
}

fn create_input(entry: &str, images: Vec<AgentCommandImage>) -> QueueEntryInput {
    QueueEntryInput {
        content: "queued work".into(),
        images,
        submission: None,
        command: Some(QueueCommandIdentity {
            key: entry.into(),
            entry_id: entry.into(),
        }),
    }
}

#[tokio::test]
async fn control_operations_share_the_controller_chat_lock_without_serializing_other_chats() {
    let harness = Harness::new();
    let mut holder = Box::pin(
        harness
            .lock
            .run_exclusive("chat:held", future::pending::<()>, None),
    );
    tokio::select! { biased;
        _ = &mut holder => panic!("the lock holder should stay pending"),
        () = future::ready(()) => {},
    }
    let input = create_input("entry", vec![]);
    let mut blocked = Box::pin(harness.operations.create("held", &input, Some(99.5)));
    tokio::select! { biased;
        _ = &mut blocked => panic!("the same chat should wait for the shared lock"),
        () = future::ready(()) => {},
    }
    assert_eq!(
        harness
            .operations
            .create("other", &input, None)
            .await
            .unwrap()
            .control
            .version,
        1
    );
    assert_eq!(harness.ports.repository.load("held").version, 0);
    assert!(
        !harness
            .ports
            .effects
            .borrow()
            .contains(&json!(["project", "held", 99.5]))
    );
    drop(holder);
    assert_eq!(blocked.await.unwrap().control.version, 1);
    assert!(
        harness
            .ports
            .effects
            .borrow()
            .contains(&json!(["project", "held", 99.5]))
    );
}

#[tokio::test]
async fn control_operations_preflight_only_new_entries_and_preserve_admission_errors() {
    let harness = Harness::new();
    let ops = &harness.operations;
    let ports = &harness.ports;
    let image = AgentCommandImage {
        data: "AAAA".into(),
        name: None,
        mime_type: None,
    };
    let input = create_input("entry", vec![image.clone()]);
    ports.project_available.set(false);
    let unavailable = ops.create("chat", &input, Some(42.5)).await.unwrap_err();
    assert_eq!(
        unavailable.downcast_ref::<DomainError>().unwrap().code,
        ErrorCode::PROJECT_UNAVAILABLE
    );
    assert_eq!(ports.repository.load("chat").version, 0);
    assert_eq!(
        &*ports.effects.borrow(),
        &[
            json!(["receipt-keys", "chat"]),
            json!(["project", "chat", 42.5])
        ]
    );

    ports.project_available.set(true);
    let committed = ops.create("chat", &input, None).await.unwrap();
    assert!(!committed.value.duplicate);
    ports.project_available.set(false);
    ports.attachment_supported.set(false);
    ports.effects.borrow_mut().clear();
    let duplicate = ops.create("chat", &input, None).await.unwrap();
    assert!(duplicate.value.duplicate);
    assert!(ports.effects.borrow().is_empty());

    ports.project_available.set(true);
    let unsupported = ops
        .create("chat", &create_input("other", vec![image]), None)
        .await
        .unwrap_err();
    assert_eq!(
        unsupported.downcast_ref::<DomainError>().unwrap().code,
        ErrorCode::UNSUPPORTED_AGENT
    );
    assert_eq!(ports.repository.load("chat").entries.len(), 1);
    assert_eq!(ports.repository.load("chat").applied_commands.len(), 1);
}

#[tokio::test]
async fn control_operations_do_not_publish_private_work_or_announce_a_duplicate() {
    let harness = Harness::new();
    let ops = &harness.operations;
    let ports = &harness.ports;
    let input = create_input("first", Vec::new());
    ops.create("chat", &input, None).await.unwrap();
    let paused = ops.pause("chat").await.unwrap();
    ports.effects.borrow_mut().clear();
    let new = create_input("second", Vec::new());
    ops.create("chat", &new, None).await.unwrap();
    ops.create("chat", &new, None).await.unwrap();
    let queued = ops
        .enqueue_control(
            "chat",
            &StoredControlInput {
                content: "system guidance".into(),
                transcript_view_id: "view".into(),
                created_at: "now".into(),
                receipt: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(queued.control.version, paused.control.version + 1);
    assert_eq!(queued.control.control_entries.len(), 1);
    {
        let effects = ports.effects.borrow();
        assert_eq!(
            effects
                .iter()
                .filter(|effect| effect[0] == "publish")
                .count(),
            1
        );
        assert_eq!(
            effects
                .iter()
                .filter(|effect| effect[0] == "accepted")
                .count(),
            2
        );
    }
    ops.resume("chat", &paused.control.pause.unwrap().id)
        .await
        .unwrap();
    ports.effects.borrow_mut().clear();
    let result = ops
        .dequeue_next_turn("chat", |_| Ok(DequeuedTurnAdmission::Inserted))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result.input, DequeuedTurnInput::Control { .. }));
    assert_eq!(result.control.version, queued.control.version + 1);
    assert!(result.control.control_entries.is_empty());
    assert!(
        !ports
            .effects
            .borrow()
            .iter()
            .any(|effect| effect[0] == "publish")
    );
}

#[tokio::test]
async fn control_operations_commit_before_publish_and_keep_the_reserved_entry_on_listener_failure()
{
    let harness = Harness::new();
    let input = create_input("entry", Vec::new());
    harness
        .operations
        .create("chat", &input, None)
        .await
        .unwrap();
    harness.ports.publish_works.set(false);
    let observed = ObservedQueueEntry {
        entry_id: "entry".into(),
        expected_revision: 1,
        expected_reorder_revision: 0,
    };
    let reserved = harness
        .operations
        .reserve_steer("chat", &observed)
        .await
        .unwrap();
    assert_eq!(reserved.entry.status, StoredQueueEntryStatus::Steering);
    assert_eq!(harness.ports.repository.load("chat"), reserved.control);
    assert!(
        harness
            .ports
            .effects
            .borrow()
            .contains(&json!(["publish", "chat", 2, 2]))
    );
}

#[tokio::test]
async fn control_operations_rejection_keeps_the_concrete_error_in_the_erased_path() {
    let harness = Harness::new();
    let input = create_input("entry", Vec::new());
    harness
        .operations
        .create("chat", &input, None)
        .await
        .unwrap();
    harness.ports.effects.borrow_mut().clear();
    let error = harness
        .operations
        .replace(
            "chat",
            &ReplaceQueueEntryInput {
                entry_id: "entry".into(),
                content: "stale".into(),
                expected_revision: 9,
                command: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        diagnostic_error_code(execution_error_input(&*error)),
        "QUEUE_ENTRY_REVISION_CONFLICT"
    );
    assert_eq!(harness.ports.repository.load("chat").version, 1);
    assert!(harness.ports.effects.borrow().is_empty());
}
