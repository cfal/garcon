//! Processing heartbeat and reconnect control snapshots from `ws/chat.ts`.

use std::{convert::Infallible, rc::Rc};

use async_trait::async_trait;
use bytes::Bytes;
use garcon_base::{
    concurrency::map_with_concurrency_result,
    log::{Logger, create_logger},
};
use garcon_chats::{chat_processing_activity::ChatProcessingActivity, store::ChatRegistry};
use garcon_contract::{
    ws_events::{
        ChatProcessingSnapshotResult, ClientRequestErrorCode, ClientRequestErrorMessage,
        ReconnectControlResult, ReconnectStateMessage, SessionWsMessage, WsFaultMessage,
    },
    ws_requests::ReconnectStateQueryRequest,
};
use garcon_execution::{
    control_projection::ClientChatExecutionControlState,
    control_state::to_client_chat_execution_control_state, types::ChatExecutionQueries,
};

use super::chat_subscribe::ChatSubscriptions;

const RECONNECT_CONTROL_READ_CONCURRENCY: f64 = 8.0;

#[async_trait(?Send)]
pub trait ChatSessionState {
    fn processing_snapshot(&self) -> ChatProcessingSnapshotResult;

    async fn reconnect(
        &self,
        request: &ReconnectStateQueryRequest,
        server_instance_id: &str,
    ) -> Result<Bytes, SessionWsMessage>;
}

pub struct BrowserChatServices {
    pub subscriptions: Rc<dyn ChatSubscriptions>,
    pub session_state: Rc<dyn ChatSessionState>,
}

pub struct ChatSessionStateHandler {
    pub registry: Rc<ChatRegistry>,
    pub processing: Rc<ChatProcessingActivity>,
    pub execution: Rc<dyn ChatExecutionQueries>,
}

impl ChatSessionStateHandler {
    async fn control(
        &self,
        chat_id: String,
    ) -> ReconnectControlResult<ClientChatExecutionControlState> {
        if !self.registry.has_chat(&chat_id) {
            return ReconnectControlResult::NotFound { chat_id };
        }
        match self.execution.read_chat_execution_control(&chat_id).await {
            Ok(control) => ReconnectControlResult::Snapshot {
                chat_id,
                control: Box::new(to_client_chat_execution_control_state(&control)),
            },
            Err(error) => {
                create_logger("ws:chat").warn(&format!(
                    "queue reconnect snapshot unavailable: {chat_id} {error}"
                ));
                ReconnectControlResult::Unavailable { chat_id }
            }
        }
    }
}

#[async_trait(?Send)]
impl ChatSessionState for ChatSessionStateHandler {
    fn processing_snapshot(&self) -> ChatProcessingSnapshotResult {
        ChatProcessingSnapshotResult::Snapshot {
            chats: self.processing.snapshot(),
        }
    }

    async fn reconnect(
        &self,
        request: &ReconnectStateQueryRequest,
        server_instance_id: &str,
    ) -> Result<Bytes, SessionWsMessage> {
        let control_results = map_with_concurrency_result(
            &request.control_chat_ids,
            RECONNECT_CONTROL_READ_CONCURRENCY,
            |chat_id, _| {
                let chat_id = chat_id.clone();
                async move { Ok::<_, Infallible>(self.control(chat_id).await) }
            },
        )
        .await
        .map_err(|error| reconnect_error(request, &error.to_string()))?;
        let reply = ReconnectStateMessage::with_control_results(
            self.processing_snapshot(),
            control_results,
            server_instance_id.into(),
            request.client_request_id.clone(),
        );
        serde_json::to_vec(&reply)
            .map(Bytes::from)
            .map_err(|error| reconnect_error(request, &error.to_string()))
    }
}

fn reconnect_error(request: &ReconnectStateQueryRequest, diagnostic: &str) -> SessionWsMessage {
    create_logger("ws:chat").error(&format!("reconnect state query failed: {diagnostic}"));
    let message = "Failed to reconcile reconnect state".into();
    match &request.client_request_id {
        Some(id) => SessionWsMessage::ClientRequestError(ClientRequestErrorMessage::new(
            id.clone(),
            ReconnectStateQueryRequest::TYPE.into(),
            ClientRequestErrorCode::InternalError,
            message,
            true,
            None,
        )),
        None => SessionWsMessage::WsFault(WsFaultMessage::new(message)),
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, path::Path, process::Command};

    use garcon_chats::chat_processing_activity::{RunningChatSource, TurnReservationSource};
    use garcon_contract::queue_state::QueueEntryKind;
    use garcon_execution::{
        control_state::{
            StoredChatExecutionControlState, StoredQueueEntry, StoredQueueEntryStatus,
            empty_stored_chat_execution_control,
        },
        types::ExecutionOperationResult,
    };
    use serde_json::{Value, json};
    use tokio::sync::{Semaphore, mpsc};

    use super::*;

    const INSTANCE: &str = "fixture-instance";
    const AT: &str = "2001-09-09T01:46:40.000Z";
    const SNAPSHOT: &str = "1000000000000001";
    const MISSING: &str = "1000000000000002";
    const UNAVAILABLE: &str = "1000000000000003";

    #[derive(Default)]
    struct Running(Cell<bool>);

    impl RunningChatSource for Running {
        fn is_chat_running(&self, chat_id: &str) -> bool {
            self.0.get() && chat_id == SNAPSHOT
        }
        fn get_running_chat_ids_snapshot(&self) -> Vec<String> {
            self.0
                .get()
                .then(|| SNAPSHOT.to_owned())
                .into_iter()
                .collect()
        }
    }

    struct NoReservations;

    impl TurnReservationSource for NoReservations {
        fn is_chat_turn_reserved(&self, _: &str) -> bool {
            false
        }
        fn get_turn_reserved_chat_ids(&self) -> Vec<String> {
            vec![]
        }
        fn is_chat_stop_in_flight(&self, _: &str) -> bool {
            false
        }
    }

    struct ControlReads {
        gates: Option<(mpsc::UnboundedSender<String>, Rc<Semaphore>)>,
    }

    #[async_trait(?Send)]
    impl ChatExecutionQueries for ControlReads {
        async fn read_chat_execution_control(
            &self,
            chat_id: &str,
        ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
            if let Some((started, release)) = &self.gates {
                started.send(chat_id.into())?;
                release.acquire().await?.forget();
            }
            assert_ne!(chat_id, MISSING, "missing chats must not read control");
            if chat_id == UNAVAILABLE {
                return Err("synthetic queue failure".into());
            }
            let mut control = empty_stored_chat_execution_control(INSTANCE);
            control.entries.push(StoredQueueEntry {
                id: "entry".into(),
                content: "Synthetic queued input".into(),
                kind: QueueEntryKind::Turn,
                revision: 2,
                created_at: AT.into(),
                updated_at: AT.into(),
                status: StoredQueueEntryStatus::Queued,
                images: vec![],
                submission: None,
            });
            Ok(control)
        }
        fn owns_execution(&self, _: &str) -> bool {
            false
        }
        fn is_chat_turn_reserved(&self, _: &str) -> bool {
            false
        }
        fn get_turn_reserved_chat_ids(&self) -> Vec<String> {
            vec![]
        }
        fn is_chat_stop_in_flight(&self, _: &str) -> bool {
            false
        }
    }

    async fn fixture(
        workspace: &Path,
        ids: &[String],
        control: ControlReads,
        running: Rc<Running>,
    ) -> ChatSessionStateHandler {
        let entry = json!({
            "agentId":"shell","agentOwnershipEpoch":"fixture-epoch","agentSettingsById":{},
            "projectPath":"/srv/seeded-project","carryOverSegments":[],"nativeSeedReceipt":null,
            "carryOverMigrationQuarantine":null,"parentChatId":null,"lineage":null,
        });
        let sessions = ids
            .iter()
            .cloned()
            .map(|id| (id, entry.clone()))
            .collect::<serde_json::Map<String, Value>>();
        std::fs::write(
            workspace.join("chats.json"),
            json!({"version":6,"sessions":sessions}).to_string(),
        )
        .unwrap();
        ChatSessionStateHandler {
            registry: ChatRegistry::open(workspace).await.unwrap(),
            processing: Rc::new(ChatProcessingActivity {
                running,
                reservations: Rc::new(NoReservations),
                is_chat_executor_reconnecting: Rc::new(|_| false),
            }),
            execution: Rc::new(control),
        }
    }

    #[tokio::test]
    async fn reconnect_snapshot_matches_bun_bytes_with_all_three_control_outcomes() {
        let directory = tempfile::tempdir().unwrap();
        let handler = fixture(
            directory.path(),
            &[SNAPSHOT.into(), UNAVAILABLE.into()],
            ControlReads { gates: None },
            Rc::default(),
        )
        .await;
        let request = ReconnectStateQueryRequest::new(
            Some("request".into()),
            vec![SNAPSHOT.into(), MISSING.into(), UNAVAILABLE.into()],
        );
        let bytes = handler.reconnect(&request, INSTANCE).await.unwrap();
        let original = Command::new("bun")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../garcon-contract/tests/oracles/reconnect-state-producer.ts"),
            )
            .output()
            .unwrap();
        assert!(
            original.status.success(),
            "{}",
            String::from_utf8_lossy(&original.stderr)
        );
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            std::str::from_utf8(&original.stdout).unwrap().trim_end()
        );
    }

    #[tokio::test]
    async fn bounds_control_reads_and_samples_processing_after_they_settle() {
        let directory = tempfile::tempdir().unwrap();
        let ids: Vec<_> = [1, 3, 4, 5, 6, 7, 8, 9, 10]
            .map(|suffix| (1_000_000_000_000_000_u64 + suffix).to_string())
            .into();
        let running = Rc::new(Running::default());
        let (started, mut requests) = mpsc::unbounded_channel();
        let release = Rc::new(Semaphore::new(0));
        let handler = fixture(
            directory.path(),
            &ids,
            ControlReads {
                gates: Some((started, release.clone())),
            },
            running.clone(),
        )
        .await;
        let request = ReconnectStateQueryRequest::new(None, ids.clone());
        let (reply, ()) = tokio::join!(handler.reconnect(&request, INSTANCE), async {
            for expected in &ids[..8] {
                assert_eq!(requests.recv().await.as_deref(), Some(expected.as_str()));
            }
            assert!(requests.try_recv().is_err());
            running.0.set(true);
            release.add_permits(8);
            assert_eq!(requests.recv().await.as_deref(), Some(ids[8].as_str()));
            release.add_permits(1);
        });
        let reply: Value = garcon_js::json::from_slice(&reply.unwrap()).unwrap();
        assert_eq!(
            reply["processing"],
            json!({"outcome":"snapshot","chats":[{"chatId":SNAPSHOT,"phase":"running"}]})
        );
        let control_results = reply["controlResults"].as_array().unwrap();
        assert_eq!(
            control_results
                .iter()
                .map(|control| control["chatId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ids,
        );
        assert_eq!(control_results[0]["outcome"], "snapshot");
        assert_eq!(control_results[1]["outcome"], "unavailable");
        assert!(reply.get("clientRequestId").is_none());
    }
}
