use garcon_execution::transcript_mutation::TranscriptMutationRegistry;
use garcon_ledger::{
    clear::TranscriptClearRegistry,
    reload::{TranscriptReloadIntegrations, TranscriptReloadRegistry},
};

use super::*;

#[tokio::test]
async fn clear_and_reload_update_only_the_pending_boundary_and_flush_it() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let registry = ChatRegistry::open(root.path()).await.unwrap();
            let raw = json!({
                "executorId":REMOTE, "agentId":"test", "agentOwnershipEpoch":"owner-a",
                "projectPath":"/project", "model":"test-model", "tags":["keep"],
                "agentSettingsById":{"test":{"ownerId":"test","schemaVersion":3,"values":{}}},
                "agentSessionId":"native-session", "nativeSession":null, "nativeSeedReceipt":null,
                "parentChatId":null,"lineage":null,"carryOverSegments":[],"carryOverMigrationQuarantine":null,
                "pendingPreambleBoundary":{"kind":"new-chat","ownershipEpoch":"owner-a"}
            });
            let record = normalize_chat_registry_entry(raw.as_object().unwrap(), CHAT).unwrap();
            let pending = record.pending_preamble_boundary.clone();
            assert!(pending.is_some());
            registry
                .add_chat(NewChatRegistryEntry {
                    id: parse_chat_id(&json!(CHAT)).unwrap(),
                    entry: record,
                })
                .unwrap();
            let adapter = TranscriptMutationRegistry::new(registry.clone());
            let clear = TranscriptClearRegistry::get_chat(&adapter, CHAT).unwrap();
            assert_eq!(clear.pending_preamble_boundary, pending);
            assert_eq!(clear.executor_id.as_deref(), Some(REMOTE));
            assert!(TranscriptClearRegistry::get_chat(&adapter, "missing").is_none());

            TranscriptClearRegistry::clear_pending_preamble_boundary(&adapter, CHAT).unwrap();
            assert!(
                registry
                    .get_chat(CHAT)
                    .unwrap()
                    .pending_preamble_boundary
                    .is_none()
            );
            registry
                .update_chat(
                    CHAT,
                    ChatRegistryPatch {
                        pending_preamble_boundary: Some(pending.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
            let captured = TranscriptReloadRegistry::get_chat(&adapter, CHAT).unwrap();
            assert_eq!(captured.pending_preamble_boundary, pending);
            let cleared = TranscriptReloadRegistry::clear_pending_preamble_boundary(&adapter, CHAT)
                .unwrap()
                .unwrap();
            assert!(cleared.pending_preamble_boundary.is_none());
            assert_eq!(cleared.transcript.session, captured.transcript.session);
            assert_eq!(
                cleared.transcript.ownership_epoch,
                captured.transcript.ownership_epoch
            );
            assert_eq!(
                cleared.transcript.executor_id,
                captured.transcript.executor_id
            );
            assert!(
                TranscriptReloadRegistry::clear_pending_preamble_boundary(&adapter, "missing")
                    .unwrap()
                    .is_none()
            );
            TranscriptReloadRegistry::flush(&adapter).await.unwrap();
            let reopened = ChatRegistry::open(root.path()).await.unwrap();
            let reopened = reopened.get_chat(CHAT).unwrap();
            assert!(reopened.pending_preamble_boundary.is_none());
            assert_eq!(reopened.tags, ["keep"]);
            assert_eq!(reopened.agent_session_id.as_deref(), Some("native-session"));
        })
        .await;
}

#[test]
fn reload_uses_only_the_selected_executors_native_importer() {
    let native: Rc<dyn AgentHistoryImport> = Rc::new(History);
    let legacy: Rc<dyn AgentHistoryImport> = Rc::new(History);
    for expected in [None, Some(native)] {
        let integration = fixture_integration(Some(legacy.clone()), expected.clone(), None);
        let settings = integration.settings.clone();
        let directory = AgentDirectory::new(Rc::new(DirectoryFixture(integration)));
        let projection =
            TranscriptReloadIntegrations::require(&directory, "test", Some(REMOTE)).unwrap();
        assert_eq!(projection.agent_id, "test");
        assert!(Rc::ptr_eq(&projection.settings, &settings));
        match expected {
            Some(native) => assert!(Rc::ptr_eq(
                projection.native_history_import.as_ref().unwrap(),
                &native
            )),
            None => assert!(projection.native_history_import.is_none()),
        }
    }
}
