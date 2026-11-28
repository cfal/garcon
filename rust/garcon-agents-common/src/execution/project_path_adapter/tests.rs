use std::cell::Cell;

use tokio::{task::LocalSet, time::sleep};

use super::*;

struct Change {
    commits: Cell<u32>,
    rollbacks: Cell<u32>,
    fail_commit: Cell<bool>,
}

#[async_trait(?Send)]
impl AgentProjectPathUpdatePreparation for Change {
    fn native_session(
        &self,
    ) -> OptionalNullable<&garcon_interface::transcript::AgentNativeSessionRef> {
        OptionalNullable::NULL
    }
    async fn commit(&self) -> ExecutorResult<()> {
        self.commits.update(|n| n + 1);
        if self.fail_commit.get() {
            return Err(std::io::Error::other("Synthetic uncertain commit").into());
        }
        Ok(())
    }
    async fn rollback(&self) -> ExecutorResult<()> {
        self.rollbacks.update(|n| n + 1);
        Ok(())
    }
}

fn scope() -> AgentResourceScope {
    AgentResourceScope {
        executor_id: "executor".into(),
        instance_id: "instance".into(),
        integration_id: "test".into(),
    }
}

fn request() -> AgentPrepareProjectPathUpdateRequest {
    garcon_js::json::from_str(r#"{
        "chat":{"chatId":"chat-1","agentId":"test","agentSessionId":"native","projectPath":"/old",
                "model":"model","nativeSession":null,"carryOverRevision":"revision","nativeSeedReceipt":null,
                "settings":{"ownerId":"test","schemaVersion":1,"values":{}}},
        "nextProjectPath":"/next"
    }"#).unwrap()
}

fn new_ids() -> Rc<dyn Fn() -> String> {
    let id = Cell::new(0);
    Rc::new(move || {
        id.update(|id| id + 1);
        id.get().to_string()
    })
}

fn code<T>(result: ExecutorResult<T>) -> AgentIntegrationErrorCode {
    result
        .err()
        .unwrap()
        .downcast_ref::<AgentCallError>()
        .unwrap()
        .code
}

#[tokio::test(start_paused = true)]
async fn commits_or_rolls_back_once_and_does_not_unblock_unknown_or_expired_decisions() {
    LocalSet::new()
        .run_until(async {
            let native = Rc::new(Change {
                commits: Cell::new(0),
                rollbacks: Cell::new(0),
                fail_commit: Cell::new(false),
            });
            let updates = create_agent_project_path_updates(
                scope(),
                Rc::new({
                    let native = native.clone();
                    move |request| {
                        let native = native.clone();
                        Box::pin(async move {
                            assert_eq!(request.next_project_path, "/next");
                            assert!(!request.signal.is_cancelled());
                            Ok(Some(native as Rc<dyn AgentProjectPathUpdatePreparation>))
                        })
                    }
                }),
                new_ids(),
            );
            let first = updates.prepare(request(), None).await.unwrap().unwrap();
            assert!(first.native_session.is_null());
            assert_eq!(
                code(updates.prepare(request(), None).await),
                AgentIntegrationErrorCode::SESSION_BUSY
            );
            updates
                .commit(first.preparation.clone(), None)
                .await
                .unwrap();
            assert_eq!(native.commits.get(), 1);
            assert_eq!(
                code(updates.commit(first.preparation, None).await),
                AgentIntegrationErrorCode::STALE_RESOURCE
            );
            let second = updates.prepare(request(), None).await.unwrap().unwrap();
            updates.rollback(second.preparation, None).await.unwrap();
            assert_eq!(native.rollbacks.get(), 1);

            let expired = updates.prepare(request(), None).await.unwrap().unwrap();
            sleep(Duration::from_secs(31)).await;
            assert_eq!(
                code(updates.rollback(expired.preparation, None).await),
                AgentIntegrationErrorCode::STALE_RESOURCE
            );
            assert_eq!(
                code(updates.prepare(request(), None).await),
                AgentIntegrationErrorCode::SESSION_BUSY
            );
            assert_eq!(native.rollbacks.get(), 1);

            let mut other = request();
            other.chat.chat_id = "chat-2".into();
            let unknown = updates.prepare(other.clone(), None).await.unwrap().unwrap();
            native.fail_commit.set(true);
            assert_eq!(
                updates
                    .commit(unknown.preparation, None)
                    .await
                    .unwrap_err()
                    .to_string(),
                "Synthetic uncertain commit"
            );
            assert_eq!(
                code(updates.prepare(other, None).await),
                AgentIntegrationErrorCode::SESSION_BUSY
            );
        })
        .await;
}

#[tokio::test]
async fn only_definitive_prepare_refusals_release_the_chat_fence() {
    for outcome in [
        AgentDeliveryOutcome::Rejected,
        AgentDeliveryOutcome::NotDispatched,
        AgentDeliveryOutcome::Unknown,
    ] {
        let calls = Rc::new(Cell::new(0));
        let updates = create_agent_project_path_updates(
            scope(),
            Rc::new({
                let calls = calls.clone();
                move |_| {
                    let count = calls.get();
                    calls.set(count + 1);
                    Box::pin(async move {
                        if count == 0 {
                            Err(AgentCallError::new(outcome, "Synthetic refusal").into())
                        } else {
                            Ok(None)
                        }
                    })
                }
            }),
            new_ids(),
        );
        assert_eq!(
            updates
                .prepare(request(), None)
                .await
                .unwrap_err()
                .to_string(),
            "Synthetic refusal"
        );
        let next = updates.prepare(request(), None).await;
        if outcome == AgentDeliveryOutcome::Unknown {
            assert_eq!(code(next), AgentIntegrationErrorCode::SESSION_BUSY);
            assert_eq!(calls.get(), 1);
        } else {
            assert!(next.unwrap().is_none());
            assert!(updates.prepare(request(), None).await.unwrap().is_none());
            assert_eq!(calls.get(), 3);
        }
    }
}
