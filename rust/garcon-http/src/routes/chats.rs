//! Chat list and selection routes from `server/controller/routes/chats.ts`.

use std::{collections::HashMap, error::Error, rc::Rc};

use garcon_base::{
    domain_error::DomainError,
    errors::ErrorInput,
    http_body::{JsonBodyError, parse_json_body},
    http_error::json_error_from_unknown,
};
use garcon_chats::{
    chat_list_projector::{ChatListProjector, ChatListSettings, ProjectedChatListEntry},
    last_selected_chat_state::InMemoryLastSelectedChatState,
    store::ChatRegistry,
};
use garcon_contract::{chat_list::ChatOrderGroup, error_codes::ErrorCode};
use garcon_js::{collation::Collation, trim};
use http::{Method, StatusCode};
use serde::Serialize;
use serde_json::Value;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteResult},
    json_route::json_response,
};

pub struct ChatListRoutes {
    pub registry: Rc<ChatRegistry>,
    pub settings: Rc<dyn ChatListSettings>,
    pub projector: Rc<ChatListProjector>,
    pub last_selected: Rc<InMemoryLastSelectedChatState>,
}

pub fn create_chat_list_routes(deps: &Rc<ChatListRoutes>) -> RouteMap<Route> {
    let list_deps = deps.clone();
    let list = Route::new(Default::default(), move |_, _, _| {
        let deps = list_deps.clone();
        async move { deps.list().or_else(|error| chat_error(error.as_ref())) }
    });
    let selected_deps = deps.clone();
    let select = Route::new(Default::default(), move |request, _, _| {
        let deps = selected_deps.clone();
        async move {
            let body = match parse_json_body(request).await {
                Ok(body) => body,
                Err(JsonBodyError::Malformed(error)) => return Err(error.into()),
                Err(JsonBodyError::Read(error)) => return Err(error as Box<dyn Error>),
            };
            deps.set_last_selected(&body)
                .or_else(|error| chat_error(error.as_ref()))
        }
    });
    RouteMap::from([
        ("/api/v1/chats".into(), [(Method::GET, list)].into()),
        (
            "/api/v1/chats/last-selected".into(),
            [(Method::PUT, select)].into(),
        ),
    ])
}

impl ChatListRoutes {
    fn list(&self) -> RouteResult {
        let sessions = self.registry.list_all_chats();
        let pinned = self.settings.pinned_chat_ids();
        let normal = self.settings.normal_chat_ids();
        let archived = self.settings.archived_chat_ids();
        let entries = self.projector.build_many(&sessions)?;
        let by_id: HashMap<_, _> = entries
            .iter()
            .map(|(id, entry)| (id.as_str(), entry))
            .collect();
        let ordered = |ids: Vec<String>, group| {
            let by_id = &by_id;
            ids.into_iter().filter_map(move |id| {
                by_id
                    .get(id.as_str())
                    .copied()
                    .filter(|entry| entry.order_group == group)
            })
        };
        let collation = Collation::english();
        let mut orphans: Vec<_> = entries
            .values()
            .filter(|entry| entry.order_group == ChatOrderGroup::Orphan)
            .collect();
        orphans.sort_by(|first, second| {
            collation
                .compare(
                    second.activity.created_at.as_deref().unwrap_or_default(),
                    first.activity.created_at.as_deref().unwrap_or_default(),
                )
                .then_with(|| collation.compare(&first.id, &second.id))
        });
        let ordered = ordered(pinned, ChatOrderGroup::Pinned)
            .chain(orphans)
            .chain(ordered(normal, ChatOrderGroup::Normal))
            .chain(ordered(archived, ChatOrderGroup::Archived))
            .collect::<Vec<_>>();
        let mut selected = self.last_selected.get_last_selected_chat_id();
        if let Some(id) = selected.as_deref()
            && !self.registry.has_chat(id)
        {
            self.last_selected.clear_if(id);
            selected = None;
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ChatListReply<'a> {
            sessions: Vec<&'a ProjectedChatListEntry>,
            total: usize,
            last_selected_chat_id: Option<String>,
        }
        Ok(json_response(
            StatusCode::OK,
            &ChatListReply {
                total: ordered.len(),
                sessions: ordered,
                last_selected_chat_id: selected,
            },
        )?)
    }

    fn set_last_selected(&self, body: &Value) -> RouteResult {
        let selected = match body.get("chatId") {
            Some(Value::Null) => None,
            raw => {
                let id = raw
                    .and_then(Value::as_str)
                    .map(trim)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| DomainError::new_validation("chatId is required"))?;
                if !self.registry.has_chat(id) {
                    return Err(DomainError::new(
                        ErrorCode::SESSION_NOT_FOUND,
                        "Session not found",
                        404,
                        false,
                    )
                    .into());
                }
                Some(id)
            }
        };
        self.last_selected.set_last_selected_chat_id(selected);
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SelectedReply<'a> {
            success: bool,
            last_selected_chat_id: Option<&'a str>,
        }
        Ok(json_response(
            StatusCode::OK,
            &SelectedReply {
                success: true,
                last_selected_chat_id: selected,
            },
        )?)
    }
}

fn chat_error(error: &(dyn Error + 'static)) -> RouteResult {
    Ok(json_error_from_unknown(ErrorInput::Error(error), None, None, None)?.map(Some))
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_chats::{
        chat_list_projector::ChatListProjectorDeps,
        metadata_store::{
            ExistingTranscriptPreview, MetadataIndex, MetadataIndexOptions,
            MetadataTranscriptSource,
        },
        registry_contracts::ChatRegistryEntry,
    };
    use garcon_contract::chat_id::ChatId;
    use serde_json::json;

    const A: &str = "1000000000000001";
    const B: &str = "1000000000000002";
    const C: &str = "1000000000000003";

    struct Settings;

    impl ChatListSettings for Settings {
        fn pinned_chat_ids(&self) -> Vec<String> {
            vec![A.into(), "999".into()]
        }

        fn normal_chat_ids(&self) -> Vec<String> {
            vec![]
        }

        fn archived_chat_ids(&self) -> Vec<String> {
            vec![]
        }

        fn chat_name(&self, _: &ChatId) -> Option<String> {
            None
        }
    }

    struct NoTranscript;

    impl MetadataTranscriptSource for NoTranscript {
        fn existing_view_id(&self, _: &ChatId) -> Result<Option<String>, Box<dyn Error>> {
            Ok(None)
        }

        fn existing_preview(
            &self,
            _: &ChatRegistryEntry,
            _: &ChatId,
        ) -> Result<Option<ExistingTranscriptPreview>, Box<dyn Error>> {
            Ok(None)
        }
    }

    async fn test_routes(dir: &std::path::Path) -> ChatListRoutes {
        let entry = json!({
            "agentId": "shell",
            "agentOwnershipEpoch": "fixture-epoch",
            "agentSettingsById": {},
            "projectPath": "/srv/seeded-project",
            "carryOverSegments": [],
            "nativeSeedReceipt": null,
            "carryOverMigrationQuarantine": null,
            "parentChatId": null,
            "lineage": null
        });
        std::fs::write(
            dir.join("chats.json"),
            json!({"version": 6, "sessions": {(A): &entry, (B): &entry, (C): &entry}}).to_string(),
        )
        .unwrap();
        let registry = ChatRegistry::open(dir).await.unwrap();
        let settings: Rc<dyn ChatListSettings> = Rc::new(Settings);
        let metadata = MetadataIndex::open(
            registry.clone(),
            Rc::new(NoTranscript),
            MetadataIndexOptions::default(),
        )
        .await;
        let projector = Rc::new(ChatListProjector::new(ChatListProjectorDeps {
            registry: registry.clone(),
            settings: settings.clone(),
            metadata,
            processing_phase: Rc::new(|_| None),
            has_pending_user_action: Rc::new(|_| false),
            can_reload_from_native_history: Rc::new(|_, _| false),
        }));
        ChatListRoutes {
            registry,
            settings,
            projector,
            last_selected: Rc::default(),
        }
    }

    #[tokio::test]
    async fn pinned_chats_precede_orphans_and_ties_follow_the_chat_id() {
        let dir = tempfile::tempdir().unwrap();
        let routes = test_routes(dir.path()).await;
        let result = routes.list().unwrap();
        let body: Value = garcon_js::json::from_slice(result.body().as_ref().unwrap()).unwrap();
        assert_eq!(body["total"], 3);
        assert_eq!(
            body["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [A, B, C]
        );
        assert_eq!(body["sessions"][0]["orderGroup"], "pinned");
        assert_eq!(body["sessions"][1]["orderGroup"], "orphan");
    }

    #[tokio::test]
    async fn selection_changes_only_after_validation_and_falls_back_when_a_chat_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let routes = test_routes(dir.path()).await;
        routes
            .set_last_selected(&json!({"chatId":format!(" {A}\t")}))
            .unwrap();
        for invalid in [
            json!({}),
            json!({"chatId": false}),
            json!({"chatId": "unknown"}),
        ] {
            assert!(routes.set_last_selected(&invalid).is_err());
            assert_eq!(
                routes.last_selected.get_last_selected_chat_id().as_deref(),
                Some(A)
            );
        }
        routes
            .last_selected
            .set_last_selected_chat_id(Some("removed"));
        let result = routes.list().unwrap();
        let body: Value = garcon_js::json::from_slice(result.body().as_ref().unwrap()).unwrap();
        assert!(body["lastSelectedChatId"].is_null());
        assert_eq!(routes.last_selected.get_last_selected_chat_id(), None);
    }
}
