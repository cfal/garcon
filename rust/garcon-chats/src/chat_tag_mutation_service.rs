//! Coordinates durable tag changes without depending on a concrete board or
//! archive service.

use std::{collections::HashSet, error::Error, future::Future, rc::Rc};

use async_trait::async_trait;
use garcon_base::{
    errors::{DiagnosticError, ErrorMetadata},
    keyed_lock::KeyedLock,
};
use garcon_contract::{
    chat_boards::{
        ChatBoardCatalog, ChatBoardColumn, ChatBoardMatchMode, calculate_chat_tag_transition,
        chat_matches_board_column,
    },
    chat_tag_mutations::{
        ApplyChatTagDeltaRequest, ChatTagTransitionTarget, ChatTagsMutationResponse,
        RecoverChatTagsResponse, ReplaceChatTagsRequest, TransitionChatTagsRequest,
    },
    chat_tags_contracts::{SetChatTagsRequest, SetChatTagsResponse},
    tags::normalize_tags,
};
use serde_json::Value;

use crate::{
    registry_contracts::ChatRegistryEntry,
    store::{
        ChatMutationDurability, ChatRegistry, ChatRegistryPatch, ReconciledDurability,
        RegistryDurability, RegistryError,
    },
};

type BoxError = Box<dyn Error>;

const BOARD_REVISION_CONFLICT: &str = "CHAT_BOARD_REVISION_CONFLICT";
const TAG_REVISION_CONFLICT: &str = "CHAT_TAG_REVISION_CONFLICT";

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ChatBoardDomainError {
    pub code: String,
    pub message: String,
    pub status: u16,
    pub retryable: bool,
    pub catalog: Option<ChatBoardCatalog>,
    pub current_tags: Option<Vec<String>>,
}

impl ChatBoardDomainError {
    pub fn new(code: &str, message: &str, status: u16, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status,
            retryable,
            catalog: None,
            current_tags: None,
        }
    }
}

impl DiagnosticError for ChatBoardDomainError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "ChatBoardDomainError",
            code: Some(&self.code),
        }
    }
}

/// Holds the catalog revision stable until the tag write settles.
pub trait TagCatalogLease {
    fn catalog(&self) -> &ChatBoardCatalog;
}

#[async_trait(?Send)]
pub trait TagBoardCatalog {
    async fn acquire_revision(
        &self,
        expected: u64,
    ) -> Result<Box<dyn TagCatalogLease + '_>, BoxError>;
}

#[async_trait(?Send)]
pub trait TagArchiveState {
    async fn confirm_archive_state(&self, chat_id: &str) -> Result<bool, BoxError>;
}

pub struct ChatTagMutationService {
    registry: Rc<ChatRegistry>,
    mutation_lock: Rc<KeyedLock>,
    boards: Rc<dyn TagBoardCatalog>,
    archive_state: Rc<dyn TagArchiveState>,
}

impl ChatTagMutationService {
    pub fn new(
        registry: Rc<ChatRegistry>,
        mutation_lock: Rc<KeyedLock>,
        boards: Rc<dyn TagBoardCatalog>,
        archive_state: Rc<dyn TagArchiveState>,
    ) -> Rc<Self> {
        Rc::new(Self {
            registry,
            mutation_lock,
            boards,
            archive_state,
        })
    }

    pub async fn set(
        self: &Rc<Self>,
        input: SetChatTagsRequest,
    ) -> Result<SetChatTagsResponse, BoxError> {
        let service = self.clone();
        self.run_locked(format!("chat:{}", input.chat_id), async move {
            let current = service.require_chat(&input.chat_id)?;
            let result = service
                .persist(&input.chat_id, &current.tags, &input.tags)
                .await?;
            Ok(SetChatTagsResponse {
                success: true,
                chat_id: input.chat_id,
                tags: result.tags,
                changed: !result.added_tags.is_empty() || !result.removed_tags.is_empty(),
            })
        })
        .await
    }

    pub async fn replace(
        self: &Rc<Self>,
        input: ReplaceChatTagsRequest,
    ) -> Result<ChatTagsMutationResponse, BoxError> {
        let service = self.clone();
        self.run_locked(format!("chat:{}", input.chat_id), async move {
            let current = service.require_chat(&input.chat_id)?;
            assert_expected_tags(&current.tags, &input.expected_tags)?;
            service
                .persist(&input.chat_id, &current.tags, &input.tags)
                .await
        })
        .await
    }

    pub async fn apply_delta(
        self: &Rc<Self>,
        input: ApplyChatTagDeltaRequest,
    ) -> Result<ChatTagsMutationResponse, BoxError> {
        let service = self.clone();
        self.run_locked(format!("chat:{}", input.chat_id), async move {
            service.apply_delta_while_chat_locked(input).await
        })
        .await
    }

    /// The command caller owns the chat lock until this operation settles.
    pub async fn apply_delta_while_chat_locked(
        &self,
        input: ApplyChatTagDeltaRequest,
    ) -> Result<ChatTagsMutationResponse, BoxError> {
        let current = self.require_chat(&input.chat_id)?;
        let removed: HashSet<_> = normalize(input.remove_tags.as_deref().unwrap_or_default())
            .into_iter()
            .collect();
        let added = normalize(input.add_tags.as_deref().unwrap_or_default());
        let tags: Vec<_> = current
            .tags
            .iter()
            .filter(|tag| !removed.contains(*tag))
            .cloned()
            .chain(added)
            .collect();
        self.persist(&input.chat_id, &current.tags, &tags).await
    }

    pub async fn transition(
        self: &Rc<Self>,
        input: TransitionChatTagsRequest,
    ) -> Result<ChatTagsMutationResponse, BoxError> {
        let service = self.clone();
        self.run_locked(format!("chat:{}", input.chat_id), async move {
            match service.transition_locked(&input).await {
                Err(mut error) => {
                    if let Some(error) = error.downcast_mut::<ChatBoardDomainError>()
                        && error.code == BOARD_REVISION_CONFLICT
                    {
                        error.current_tags = Some(service.require_chat(&input.chat_id)?.tags);
                    }
                    Err(error)
                }
                result => result,
            }
        })
        .await
    }

    pub async fn recover(
        self: &Rc<Self>,
        chat_id: &str,
    ) -> Result<RecoverChatTagsResponse, BoxError> {
        let service = self.clone();
        let id = chat_id.to_owned();
        self.run_locked(format!("chat:{chat_id}"), async move {
            match service.registry.reconcile_unknown_durability(&id).await {
                ReconciledDurability::Unavailable => return Err(not_found().into()),
                ReconciledDurability::StillUnknown => return Err(save_unknown(true).into()),
                ReconciledDurability::Confirmed => {}
            }
            let current = service.require_chat(&id)?;
            Ok(RecoverChatTagsResponse {
                success: true,
                chat_id: id,
                tags: current.tags,
            })
        })
        .await
    }

    async fn run_locked<T: 'static>(
        &self,
        key: String,
        work: impl Future<Output = Result<T, BoxError>> + 'static,
    ) -> Result<T, BoxError> {
        let lock = self.mutation_lock.clone();
        tokio::task::spawn_local(async move { lock.run_exclusive_many(&[&key], || work).await })
            .await?
    }

    async fn transition_locked(
        &self,
        input: &TransitionChatTagsRequest,
    ) -> Result<ChatTagsMutationResponse, BoxError> {
        let lease = self
            .boards
            .acquire_revision(input.expected_catalog_revision)
            .await?;
        let catalog = lease.catalog();
        let current = self.require_chat(&input.chat_id)?;
        if self
            .archive_state
            .confirm_archive_state(&input.chat_id)
            .await?
        {
            return Err(ChatBoardDomainError::new(
                "CHAT_BOARD_TRANSITION_CHAT_ARCHIVED",
                "Archived chats cannot be transitioned",
                409,
                false,
            )
            .into());
        }
        assert_expected_tags(&current.tags, &input.expected_tags).map_err(|mut error| {
            error.catalog = Some(catalog.clone());
            error
        })?;
        if let ChatTagTransitionTarget::Column { column_id, .. } = &input.target
            && *column_id == input.source_column_id
        {
            return Err(invalid_transition("Source and target columns must differ").into());
        }
        let board = catalog
            .boards
            .iter()
            .find(|board| board.id == input.board_id)
            .ok_or_else(|| {
                ChatBoardDomainError::new(
                    "CHAT_BOARD_NOT_FOUND",
                    "Chat board not found",
                    404,
                    false,
                )
            })?;
        let source = find_column(&board.columns, &input.source_column_id)?;
        if !chat_matches_board_column(&current.tags, &source.rule) {
            return Err(invalid_transition("Chat no longer matches the source column").into());
        }
        let target_tags = match &input.target {
            ChatTagTransitionTarget::None => &[],
            ChatTagTransitionTarget::Column {
                column_id,
                selected_target_tags,
            } => {
                let target = &find_column(&board.columns, column_id)?.rule;
                match target.r#match {
                    ChatBoardMatchMode::All => target.tags.as_slice(),
                    ChatBoardMatchMode::Any => {
                        selected_any_tags(&target.tags, selected_target_tags.as_deref())?
                    }
                }
            }
        };
        let preview = calculate_chat_tag_transition(&current.tags, &source.rule.tags, target_tags);
        if preview.resulting_tags == current.tags {
            return Err(ChatBoardDomainError::new(
                "CHAT_BOARD_TRANSITION_NOOP",
                "The transition would not change any tags",
                409,
                false,
            )
            .into());
        }
        self.persist(&input.chat_id, &current.tags, &preview.resulting_tags)
            .await
    }

    fn require_chat(&self, chat_id: &str) -> Result<ChatRegistryEntry, ChatBoardDomainError> {
        match self.registry.chat_mutation_durability(chat_id) {
            ChatMutationDurability::Unavailable => Err(not_found()),
            ChatMutationDurability::Unknown => Err(save_unknown(false)),
            ChatMutationDurability::Confirmed => {
                self.registry.get_chat(chat_id).ok_or_else(not_found)
            }
        }
    }

    async fn persist(
        &self,
        chat_id: &str,
        previous: &[String],
        next: &[String],
    ) -> Result<ChatTagsMutationResponse, BoxError> {
        let tags = normalize(next);
        let before: HashSet<_> = previous.iter().collect();
        let after: HashSet<_> = tags.iter().collect();
        let added_tags = tags
            .iter()
            .filter(|tag| !before.contains(*tag))
            .cloned()
            .collect();
        let removed_tags = previous
            .iter()
            .filter(|tag| !after.contains(*tag))
            .cloned()
            .collect();
        let tags = if previous == tags {
            tags
        } else {
            let result = self
                .registry
                .update_chat_phased(
                    chat_id,
                    ChatRegistryPatch {
                        tags: Some(tags),
                        ..Default::default()
                    },
                )
                .await
                .map_err(registry_failure)?
                .ok_or_else(not_found)?;
            if result.durability == RegistryDurability::Unknown {
                return Err(save_unknown(false).into());
            }
            result.entry.entry.tags
        };
        Ok(ChatTagsMutationResponse {
            success: true,
            chat_id: chat_id.to_owned(),
            tags,
            added_tags,
            removed_tags,
        })
    }
}

fn registry_failure(error: RegistryError) -> BoxError {
    if matches!(error, RegistryError::DurabilityUnknown(_)) {
        return save_unknown(false).into();
    }
    let error = error.into_original_error();
    if error.is::<ChatBoardDomainError>() {
        error
    } else {
        ChatBoardDomainError::new(
            "CHAT_TAG_SAVE_FAILED",
            "Chat tags could not be saved",
            503,
            true,
        )
        .into()
    }
}

fn normalize(tags: &[String]) -> Vec<String> {
    normalize_tags(&tags.iter().cloned().map(Value::String).collect::<Vec<_>>())
}

fn find_column<'a>(
    columns: &'a [ChatBoardColumn],
    id: &str,
) -> Result<&'a ChatBoardColumn, ChatBoardDomainError> {
    columns
        .iter()
        .find(|column| column.id == id)
        .ok_or_else(|| {
            ChatBoardDomainError::new(
                "CHAT_BOARD_NOT_FOUND",
                "Chat board column not found",
                404,
                false,
            )
        })
}

fn selected_any_tags<'a>(
    target_tags: &[String],
    selected: Option<&'a [String]>,
) -> Result<&'a [String], ChatBoardDomainError> {
    let selected = selected
        .filter(|tags| !tags.is_empty())
        .ok_or_else(|| invalid_transition("At least one target tag must be selected"))?;
    if normalize(selected) != selected || selected.iter().any(|tag| !target_tags.contains(tag)) {
        return Err(invalid_transition(
            "Selected tags must be a canonical subset of the target column",
        ));
    }
    Ok(selected)
}

fn assert_expected_tags(
    current: &[String],
    expected: &[String],
) -> Result<(), ChatBoardDomainError> {
    if current == normalize(expected) {
        return Ok(());
    }
    let mut error = ChatBoardDomainError::new(
        TAG_REVISION_CONFLICT,
        "Chat tags changed in another client; review the latest tags",
        409,
        true,
    );
    error.current_tags = Some(current.to_vec());
    Err(error)
}

fn invalid_transition(message: &str) -> ChatBoardDomainError {
    ChatBoardDomainError::new("CHAT_BOARD_TRANSITION_INVALID", message, 400, false)
}

fn not_found() -> ChatBoardDomainError {
    ChatBoardDomainError::new("SESSION_NOT_FOUND", "Session not found", 404, false)
}

fn save_unknown(retryable: bool) -> ChatBoardDomainError {
    ChatBoardDomainError::new(
        "CHAT_TAG_SAVE_UNKNOWN",
        "The tag save may have completed and must be confirmed before another change",
        503,
        retryable,
    )
}
