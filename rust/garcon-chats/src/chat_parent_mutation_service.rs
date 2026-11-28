//! Coordinates a durable delegation-parent change with chat lifecycle locks.

use std::{error::Error, rc::Rc};

use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    keyed_lock::KeyedLock,
};
use garcon_contract::{
    chat_parent_contracts::{SetChatParentRequest, SetChatParentResponse},
    error_codes::ErrorCode,
};

use crate::store::{ChatRegistry, ReconciledDurability, RegistryDurability, RegistryError};

pub struct ChatParentMutationService {
    registry: Rc<ChatRegistry>,
    mutation_lock: Rc<KeyedLock>,
}

impl ChatParentMutationService {
    pub fn new(registry: Rc<ChatRegistry>, mutation_lock: Rc<KeyedLock>) -> Self {
        Self {
            registry,
            mutation_lock,
        }
    }

    pub async fn set(
        &self,
        input: SetChatParentRequest,
    ) -> Result<SetChatParentResponse, Box<dyn Error>> {
        let registry = self.registry.clone();
        let lock = self.mutation_lock.clone();
        // Dropping a reply must not release the chat locks during an admitted write.
        tokio::task::spawn_local(async move {
            let child_key = format!("chat:{}", input.chat_id);
            let parent_key = input.parent_chat_id.as_ref().map(|id| format!("chat:{id}"));
            let mut keys = vec![child_key.as_str()];
            if let Some(key) = parent_key.as_deref() {
                keys.push(key);
            }
            lock.run_exclusive_many(&keys, || set_locked(registry, input))
                .await
        })
        .await
        .map_err(|error| save_failed(Box::new(error)))?
    }
}

async fn set_locked(
    registry: Rc<ChatRegistry>,
    input: SetChatParentRequest,
) -> Result<SetChatParentResponse, Box<dyn Error>> {
    match registry.reconcile_unknown_durability(&input.chat_id).await {
        ReconciledDurability::Unavailable => return Err(not_found().into()),
        ReconciledDurability::StillUnknown => return Err(save_unknown().into()),
        ReconciledDurability::Confirmed => {}
    }
    let result = registry
        .set_delegation_parent_phased(&input.chat_id, input.parent_chat_id)
        .await
        .map_err(registry_failure)?
        .ok_or_else(not_found)?;
    if result.durability == RegistryDurability::Unknown {
        return Err(save_unknown().into());
    }
    Ok(SetChatParentResponse {
        success: true,
        chat_id: input.chat_id,
        parent_chat_id: result.entry.entry.parent_chat_id,
        changed: result.changed,
    })
}

fn registry_failure(error: RegistryError) -> Box<dyn Error> {
    if matches!(error, RegistryError::DurabilityUnknown(_)) {
        return save_unknown().into();
    }
    let error = error.into_original_error();
    if as_domain_error(error.as_ref()).is_some() {
        error
    } else {
        save_failed(error).into()
    }
}

fn not_found() -> DomainError {
    DomainError::new(
        ErrorCode::SESSION_NOT_FOUND,
        "Session not found",
        404,
        false,
    )
}

fn save_unknown() -> DomainError {
    DomainError::new(
        ErrorCode::CHAT_PARENT_SAVE_UNKNOWN,
        "The parent save may have completed. Inspect the chat before explicitly trying again.",
        503,
        false,
    )
}

fn save_failed(cause: Box<dyn Error>) -> DomainError {
    DomainError::new(
        ErrorCode::CHAT_PARENT_SAVE_FAILED,
        "Chat parent could not be saved",
        503,
        true,
    )
    .with_cause(cause)
}
