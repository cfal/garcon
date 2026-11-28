use garcon_base::ticket_error::validate_ticket_input;
use garcon_contract::{
    ticket_validation::{TicketValidationError, ticket_actor, ticket_owner},
    tickets::{TicketActor, TicketOwner, TicketPrincipalMode, TicketSource},
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::errors::Result;

#[derive(Clone)]
pub enum TicketAuthority {
    Chat { chat_id: String },
    Principal { mode: &'static str, key: String },
}

pub enum TicketPrincipal<'a> {
    Local,
    Authenticated { key: &'a str, username: &'a str },
    Executor { executor_id: &'a str },
}

#[derive(Clone)]
pub struct TicketCaller {
    pub authority: TicketAuthority,
    pub actor: TicketActor,
    pub owner: TicketOwner,
}

pub struct TicketMutationContext {
    pub caller: TicketCaller,
    pub expected_store_id: String,
    pub source: Option<TicketSource>,
    pub operation_key: String,
    pub fingerprint: String,
}

pub fn ticket_authority_key(authority: &TicketAuthority) -> String {
    match authority {
        TicketAuthority::Chat { chat_id } => json!(["chat", chat_id]),
        TicketAuthority::Principal { mode, key } => json!(["principal", mode, key]),
    }
    .to_string()
}

pub fn derive_ticket_caller(
    principal: TicketPrincipal<'_>,
    from_chat_id: Option<&str>,
) -> Result<TicketCaller> {
    let from_chat = from_chat_id.map(|chat_id| TicketOwner::Chat {
        chat_id: chat_id.into(),
    });
    let declared_chat_id = from_chat_id.map(str::to_owned);
    let (mode, key, actor, owner) = match principal {
        TicketPrincipal::Executor { executor_id } => (
            "executor",
            executor_id,
            TicketActor::Executor {
                executor_id: executor_id.into(),
                declared_chat_id,
            },
            TicketOwner::Executor {
                executor_id: executor_id.into(),
            },
        ),
        TicketPrincipal::Local => (
            "local",
            "local",
            TicketActor::User {
                username: "local".into(),
                principal_mode: TicketPrincipalMode::Local,
                declared_chat_id,
            },
            TicketOwner::User {
                owner_key: "local".into(),
            },
        ),
        TicketPrincipal::Authenticated { key, username } => (
            "authenticated",
            key,
            TicketActor::User {
                username: username.into(),
                principal_mode: TicketPrincipalMode::Authenticated,
                declared_chat_id,
            },
            TicketOwner::User {
                owner_key: key.into(),
            },
        ),
    };
    validate_ticket_caller(TicketCaller {
        authority: TicketAuthority::Principal {
            mode,
            key: key.into(),
        },
        actor,
        owner: from_chat.unwrap_or(owner),
    })
}

pub fn validate_ticket_caller(caller: TicketCaller) -> Result<TicketCaller> {
    validate_ticket_input(|| -> Result<_> {
        let actor = ticket_actor(&serde_json::to_value(&caller.actor)?)?;
        let owner = ticket_owner(&serde_json::to_value(&caller.owner)?)?;
        if let (
            TicketActor::User { username, .. },
            TicketActor::User {
                username: original, ..
            },
        ) = (&actor, &caller.actor)
            && username != original
        {
            return Err(TicketValidationError::new(
                "The authenticated username must be a canonical ticket identity.",
            )
            .into());
        }
        Ok(TicketCaller {
            authority: caller.authority,
            actor,
            owner,
        })
    })
}

pub fn ticket_fingerprint(payload: &impl Serialize, caller: &TicketCaller) -> Result<String> {
    // Durable operation hashes use the legacy user spelling, in the original field order.
    let mut projected = serde_json::to_value(payload)?;
    let field = match projected["action"].as_str() {
        Some("create") => Some("input"),
        Some("update") => Some("patch"),
        _ => None,
    };
    if let Some(assignee) = field
        .and_then(|field| projected.get_mut(field))
        .and_then(|fields| fields.get_mut("assignee"))
        && assignee["kind"] == "user"
    {
        *assignee = json!({"kind":"user", "username":assignee["ownerKey"]});
    }
    let mut actor = serde_json::to_value(&caller.actor)?;
    if let (TicketActor::User { .. }, TicketAuthority::Principal { key, .. }) =
        (&caller.actor, &caller.authority)
    {
        actor["username"] = Value::String(key.clone());
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(projected, actor))?)
    ))
}
