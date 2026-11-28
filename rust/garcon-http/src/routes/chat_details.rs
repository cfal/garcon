//! Chat details from `server/controller/routes/chats.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError, errors::ErrorInput, http_error::json_error_from_unknown,
};
use garcon_chats::{
    carryover::segments::carry_over_revision,
    metadata_store::{ChatMetadata, MetadataIndex},
    registry_contracts::{CarryOverSegmentRef, ChatRegistryEntry},
    store::ChatRegistry,
};
use garcon_contract::{
    chat_details::{
        ChatCarryOverDetailsDto, ChatCarryOverHandoffDto, ChatCarryOverSegmentDto,
        ChatDetailsResponse, ChatTranscriptSourceDto,
    },
    chat_id::parse_chat_id,
    error_codes::ErrorCode,
};
use garcon_interface::{resources::ExecutorResult, transcript::AgentTranscriptSourceLocation};
use http::{Method, StatusCode};
use serde_json::Value;
use url::Url;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteResult},
    json_route::json_response,
};

#[async_trait(?Send)]
pub trait DescribeTranscriptSource {
    async fn describe_transcript_source(
        &self,
        session: &ChatRegistryEntry,
        chat_id: &str,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>>;
}

pub struct ChatDetailsRoutes {
    pub registry: Rc<ChatRegistry>,
    pub metadata: Rc<MetadataIndex>,
    pub sources: Rc<dyn DescribeTranscriptSource>,
    pub archived_logical_count: fn(&[CarryOverSegmentRef]) -> u64,
}

pub fn create_chat_details_routes(deps: &Rc<ChatDetailsRoutes>) -> RouteMap<Route> {
    let deps = Rc::clone(deps);
    let get = Route::new(Default::default(), move |_, url, _| {
        let deps = Rc::clone(&deps);
        async move {
            match deps.details(&url).await {
                Ok(response) => Ok(response),
                Err(error) => Ok(json_error_from_unknown(
                    ErrorInput::Error(error.as_ref()),
                    None,
                    None,
                    None,
                )?
                .map(Some)),
            }
        }
    });
    RouteMap::from([("/api/v1/chats/details".into(), [(Method::GET, get)].into())])
}

impl ChatDetailsRoutes {
    async fn details(&self, url: &Url) -> RouteResult {
        let raw_id = details_chat_id(url)?;
        let session = self.registry.get_chat(&raw_id).ok_or_else(|| {
            DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                "Session not found",
                404,
                false,
            )
        })?;
        let chat_id = parse_chat_id(&Value::String(raw_id))?;
        let metadata = self.metadata.get_chat_metadata(&chat_id);
        let source = self
            .sources
            .describe_transcript_source(&session, &chat_id)
            .await?;
        let count = (self.archived_logical_count)(&session.carry_over_segments);
        let response = project_details(chat_id.as_str(), &session, metadata, source, count);
        Ok(json_response(StatusCode::OK, &response)?)
    }
}

fn details_chat_id(url: &Url) -> Result<String, DomainError> {
    url.query_pairs()
        .find_map(|(key, value)| (key == "chatId").then_some(value.into_owned()))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DomainError::new_validation("chatId query parameter is required"))
}

fn project_details(
    chat_id: &str,
    session: &ChatRegistryEntry,
    metadata: Option<ChatMetadata>,
    source: Option<AgentTranscriptSourceLocation>,
    archived_message_count: u64,
) -> ChatDetailsResponse {
    let (first_message, created_at, last_activity_at) = metadata
        .map(|meta| (meta.first_message, meta.created_at, meta.last_activity))
        .unwrap_or_default();
    let transcript_source = source.map(|source| match source {
        AgentTranscriptSourceLocation::FilesystemPath { value } => {
            ChatTranscriptSourceDto::FilesystemPath { value }
        }
        AgentTranscriptSourceLocation::ProviderReference { value } => {
            ChatTranscriptSourceDto::ProviderReference { value }
        }
    });
    ChatDetailsResponse {
        chat_id: chat_id.into(),
        first_message,
        created_at: created_at.filter(|at| !at.is_empty()),
        last_activity_at: last_activity_at.filter(|at| !at.is_empty()),
        agent_session_id: session.agent_session_id.clone().filter(|id| !id.is_empty()),
        transcript_source,
        carry_over: ChatCarryOverDetailsDto {
            revision: carry_over_revision(
                &session.carry_over_segments,
                session.carry_over_migration_quarantine.as_ref(),
            ),
            archived_message_count,
            segments: session
                .carry_over_segments
                .iter()
                .map(segment_details)
                .collect(),
        },
    }
}

fn segment_details(segment: &CarryOverSegmentRef) -> ChatCarryOverSegmentDto {
    ChatCarryOverSegmentDto {
        id: segment.id.clone(),
        agent_id: segment.agent_id.clone(),
        model: segment.model.clone(),
        captured_at: segment.captured_at.clone(),
        stored_message_count: segment.stored_message_count,
        visible_message_count: segment.visible_message_count,
        truncated: segment.visible_message_count < segment.stored_message_count,
        trailing_handoff: segment
            .trailing_handoff
            .as_ref()
            .map(|target| ChatCarryOverHandoffDto {
                agent_id: target.agent_id.clone(),
                model: target.model.clone(),
            }),
    }
}

#[cfg(test)]
mod tests {
    use garcon_chats::{
        metadata_store::MetadataSource, registry_contracts::CarryOverHandoffTarget,
        registry_entry_codec::normalize_chat_registry_entry,
    };
    use serde_json::json;

    use super::*;

    const CHAT: &str = "1000000000000001";
    const AT: &str = "2026-11-28T10:00:00.000Z";

    #[test]
    fn details_uses_the_first_query_value_without_trimming_it() {
        let url = |query| Url::parse(&format!("http://local/api/v1/chats/details{query}")).unwrap();
        for query in ["", "?chatId=", "?chatId=&chatId=valid"] {
            let error = details_chat_id(&url(query)).unwrap_err();
            assert_eq!(error.status, 400);
            assert_eq!(error.message, "chatId query parameter is required");
        }
        assert_eq!(
            details_chat_id(&url("?chatId=%20id&chatId=other")).unwrap(),
            " id"
        );
    }

    #[test]
    fn projects_first_preview_and_carryover_without_exposing_registry_fields() {
        let raw = json!({
            "agentId":"shell","agentOwnershipEpoch":"fixture-epoch","agentSettingsById":{},
            "projectPath":"/srv/seeded-project","carryOverSegments":[],"nativeSeedReceipt":null,
            "carryOverMigrationQuarantine":null,"parentChatId":null,"lineage":null,
        });
        let mut session = normalize_chat_registry_entry(raw.as_object().unwrap(), CHAT).unwrap();
        let no_history = project_details(CHAT, &session, None, None, 0);
        assert_eq!(
            serde_json::to_value(no_history).unwrap(),
            json!({
                "chatId":CHAT,"firstMessage":"","createdAt":null,"lastActivityAt":null,
                "agentSessionId":null,"transcriptSource":null,
                "carryOver":{"revision":"carry-v1:0","archivedMessageCount":0,"segments":[]},
            })
        );
        let metadata = ChatMetadata {
            chat_id: CHAT.into(),
            first_message: "Synthetic first prompt".into(),
            last_message: "Not projected".into(),
            created_at: Some(String::new()),
            last_activity: Some(AT.into()),
            transcript_view_id: Some("view".into()),
            source: MetadataSource::Live,
            identity: None,
        };
        session.agent_session_id = Some("native-session".into());
        session.carry_over_segments.push(CarryOverSegmentRef {
            id: "segment-one".into(),
            agent_id: "shell".into(),
            model: "source-model".into(),
            captured_at: AT.into(),
            stored_message_count: 8,
            visible_message_count: 5,
            trailing_handoff: Some(CarryOverHandoffTarget {
                agent_id: "shell".into(),
                model: "target-model".into(),
            }),
        });
        let details = project_details(
            CHAT,
            &session,
            Some(metadata),
            Some(AgentTranscriptSourceLocation::ProviderReference {
                value: "synthetic-source".into(),
            }),
            6,
        );
        assert_eq!(details.first_message, "Synthetic first prompt");
        assert_eq!(details.created_at, None);
        assert_eq!(details.last_activity_at.as_deref(), Some(AT));
        assert_eq!(details.agent_session_id.as_deref(), Some("native-session"));
        assert_eq!(
            details.transcript_source,
            Some(ChatTranscriptSourceDto::ProviderReference {
                value: "synthetic-source".into(),
            })
        );
        assert!(details.carry_over.revision.starts_with("carry-v5:"));
        assert_eq!(details.carry_over.archived_message_count, 6);
        assert_eq!(details.carry_over.segments[0].stored_message_count, 8);
        assert_eq!(details.carry_over.segments[0].visible_message_count, 5);
        assert!(details.carry_over.segments[0].truncated);
        assert_eq!(
            details.carry_over.segments[0]
                .trailing_handoff
                .as_ref()
                .unwrap()
                .model,
            "target-model"
        );
    }
}
