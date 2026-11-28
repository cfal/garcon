use std::rc::Rc;

use garcon_base::{
    log::{Logger, create_logger},
    ticket_error::validate_ticket_input,
};
use garcon_contract::{
    error_codes::ErrorCode,
    ticket_commands::{HttpTicketMutationRequest, TicketMutationPayload},
    ticket_query::{
        parse_ticket_comments_query, parse_ticket_history_query, parse_ticket_list_query,
        parse_ticket_read_query,
    },
    ticket_validation::{ticket_integer, ticket_record, ticket_string},
    tickets::{
        TICKET_LIMITS, TicketActivity, TicketActor, TicketBootstrap, TicketCollectionVersion,
        TicketCommentView, TicketCounts, TicketDetail, TicketFacets, TicketOwner, TicketPage,
        TicketSequencePage, TicketWriteResult,
    },
};
use garcon_js::{Clock, clock::to_iso_string};
use rusqlite::params;
use serde_json::{Value, json};

use super::{
    contracts::{
        TicketAuthority, TicketCaller, TicketMutationContext, ticket_authority_key,
        ticket_fingerprint, validate_ticket_caller,
    },
    errors::{MissingChatAuthority, Result, next_ticket_counter, ticket_error},
    mutations::mutate_ticket,
    queries::{
        Facet, count_tickets, list_tickets, read_ticket_comments, read_ticket_detail,
        read_ticket_history, ticket_facets,
    },
    records::{collection_revision, initial_comment_value, read_operation},
    store::TicketStore,
};

type ChatExists = Rc<dyn Fn(&str) -> bool>;
type InvalidationListener = Rc<dyn Fn(u64) -> Result<()>>;

pub struct TicketServiceOptions {
    pub chat_exists: Option<ChatExists>,
    pub commands_enabled: Rc<dyn Fn() -> bool>,
    pub on_invalidated: Option<InvalidationListener>,
    pub clock: Rc<dyn Clock>,
}

pub struct TicketService {
    store: TicketStore,
    options: TicketServiceOptions,
}

impl TicketService {
    pub fn new(store: TicketStore, options: TicketServiceOptions) -> Self {
        Self { store, options }
    }

    pub fn store_id(&self) -> &str {
        self.store.store_id()
    }

    pub fn bootstrap(&self, authority: &TicketAuthority) -> Result<TicketBootstrap> {
        self.store.read(|database| {
            Ok(TicketBootstrap {
                version: TicketCollectionVersion {
                    store_id: self.store_id().into(),
                    collection_revision: collection_revision(database)?,
                },
                viewer_key: ticket_authority_key(authority),
            })
        })
    }

    pub fn lookup_operation(
        &self,
        context: &TicketMutationContext,
    ) -> Result<Option<TicketWriteResult>> {
        self.admit(context)?;
        self.store
            .read(|database| read_operation(database, context))
    }

    pub fn execute_http(
        &self,
        request: HttpTicketMutationRequest,
        caller: TicketCaller,
        signal: &tokio_util::sync::CancellationToken,
    ) -> Result<TicketWriteResult> {
        let declared = match &caller.actor {
            TicketActor::Chat { .. } => None,
            TicketActor::User {
                declared_chat_id, ..
            }
            | TicketActor::Executor {
                declared_chat_id, ..
            } => Some(declared_chat_id),
        };
        if declared != Some(&request.from_chat_id) {
            return Err(ticket_error(
                ErrorCode::TICKET_UNAUTHORIZED,
                "Ticket caller does not match the authenticated request.",
            ));
        }
        let context = TicketMutationContext {
            expected_store_id: request.expected_store_id,
            source: None,
            operation_key: json!([
                "http",
                ticket_authority_key(&caller.authority),
                request.request_id
            ])
            .to_string(),
            fingerprint: ticket_fingerprint(&request.payload, &caller)?,
            caller,
        };
        if signal.is_cancelled() {
            return Err("The operation was aborted.".into());
        }
        self.execute(request.payload, context)
    }

    pub fn execute(
        &self,
        payload: TicketMutationPayload,
        mut context: TicketMutationContext,
    ) -> Result<TicketWriteResult> {
        context.caller = validate_ticket_caller(context.caller)?;
        self.admit(&context)?;
        let (result, changed) = self.store.transaction(|database| {
            self.admit(&context)?;
            if let Some(previous) = read_operation(database, &context)? {
                return Ok((previous, false));
            }
            self.require_references(&payload, &context)?;
            let initial_comment = matches!(
                payload,
                TicketMutationPayload::Comment { .. } | TicketMutationPayload::Close { .. }
            );
            let now = to_iso_string(self.options.clock.now_ms())?;
            let commit = mutate_ticket(database, payload, &context, &now)?;
            let mut revision = collection_revision(database)?;
            if commit.changed {
                revision = next_ticket_counter(revision as f64)?;
                database
                    .prepare_cached("UPDATE ticket_meta SET revision=? WHERE singleton=1")?
                    .execute([revision as i64])?;
            }
            let result = TicketWriteResult {
                success: true,
                version: TicketCollectionVersion {
                    store_id: self.store_id().into(),
                    collection_revision: revision,
                },
                ticket: commit.ticket,
                comment: commit.comment,
                related_ticket: commit.related_ticket,
            };
            let mut stored = serde_json::to_value(&result)?;
            if initial_comment && let Some(comment) = &result.comment {
                stored["comment"] = initial_comment_value(comment)?;
            }
            database
                .prepare_cached("INSERT INTO ticket_operations VALUES (?,?,?)")?
                .execute(params![
                    context.operation_key,
                    context.fingerprint,
                    serde_json::to_string(&stored)?
                ])?;
            Ok((result, commit.changed))
        })?;
        if changed
            && let Some(listener) = &self.options.on_invalidated
            && listener(result.version.collection_revision).is_err()
        {
            create_logger("tickets").warn("Ticket invalidation listener failed after commit.");
        }
        Ok(result)
    }

    pub fn list(&self, value: &Value) -> Result<TicketPage> {
        let query = validate_ticket_input(|| parse_ticket_list_query(value))?;
        self.store.read(|database| {
            list_tickets(database, self.store_id(), &query, TICKET_LIMITS.http_bytes)
        })
    }

    pub fn counts(&self, value: &Value) -> Result<TicketCounts> {
        let query = validate_ticket_input(|| {
            ticket_record(
                value,
                &[
                    "project",
                    "status",
                    "includeClosed",
                    "priority",
                    "label",
                    "assignee",
                    "ready",
                    "query",
                    "expectedCollectionRevision",
                ],
            )?;
            parse_ticket_list_query(value)
        })?;
        self.store
            .read(|database| count_tickets(database, self.store_id(), &query))
    }

    pub fn read(&self, value: &Value, authority: &TicketAuthority) -> Result<TicketDetail> {
        let query = validate_ticket_input(|| parse_ticket_read_query(value))?;
        self.store.read(|database| {
            read_ticket_detail(
                database,
                self.store_id(),
                &query,
                authority,
                TICKET_LIMITS.http_bytes,
            )
        })
    }

    pub fn comments(
        &self,
        value: &Value,
        authority: &TicketAuthority,
    ) -> Result<TicketSequencePage<TicketCommentView>> {
        let query = validate_ticket_input(|| parse_ticket_comments_query(value))?;
        self.store.read(|database| {
            read_ticket_comments(
                database,
                self.store_id(),
                &query,
                authority,
                TICKET_LIMITS.http_bytes,
            )
        })
    }

    pub fn history(&self, value: &Value) -> Result<TicketSequencePage<TicketActivity>> {
        let query = validate_ticket_input(|| parse_ticket_history_query(value))?;
        self.store.read(|database| {
            read_ticket_history(database, self.store_id(), &query, TICKET_LIMITS.http_bytes)
        })
    }

    pub fn facets(&self, field: Facet, prefix: &str) -> Result<TicketFacets> {
        validate_ticket_input(|| {
            ticket_string(&Value::String(prefix.into()), "prefix")?;
            ticket_integer(
                &json!(prefix.chars().count()),
                "prefix length",
                Some(0.0),
                Some(4096.0),
            )?;
            Ok::<_, garcon_contract::ticket_validation::TicketValidationError>(())
        })?;
        self.store
            .read(|database| ticket_facets(database, self.store_id(), field, prefix))
    }

    pub fn close(&self) {
        self.store.close();
    }

    fn admit(&self, context: &TicketMutationContext) -> Result<()> {
        if context.expected_store_id != self.store_id() {
            return Err(ticket_error(
                ErrorCode::TICKET_STORE_CHANGED,
                "Ticket storage changed. Preserve the draft and refresh before creating a new request.",
            ));
        }
        let from_chat = match &context.caller.actor {
            TicketActor::Chat { .. } => true,
            TicketActor::Executor {
                declared_chat_id, ..
            }
            | TicketActor::User {
                declared_chat_id, ..
            } => declared_chat_id.is_some(),
        };
        if from_chat && !(self.options.commands_enabled)() {
            return Err(ticket_error(
                ErrorCode::TICKET_COMMANDS_DISABLED,
                "Agent ticket commands are disabled.",
            ));
        }
        Ok(())
    }

    fn require_references(
        &self,
        payload: &TicketMutationPayload,
        context: &TicketMutationContext,
    ) -> Result<()> {
        let caller = &context.caller;
        let chat_id = match &caller.actor {
            TicketActor::Chat { chat_id, .. } => Some(chat_id),
            TicketActor::Executor {
                declared_chat_id, ..
            }
            | TicketActor::User {
                declared_chat_id, ..
            } => declared_chat_id.as_ref(),
        };
        if let Some(id) = chat_id {
            self.require_chat(id)?;
        }
        let owner = match payload {
            TicketMutationPayload::Claim(_) | TicketMutationPayload::Release(_) => {
                Some(&caller.owner)
            }
            TicketMutationPayload::Create { input } => input.assignee.as_ref(),
            TicketMutationPayload::Update(update) => update.patch.assignee.as_option(),
            _ => None,
        };
        if let Some(owner) = owner {
            self.require_owner(owner, caller)?;
        }
        Ok(())
    }

    fn require_owner(&self, owner: &TicketOwner, caller: &TicketCaller) -> Result<()> {
        match owner {
            TicketOwner::Chat { chat_id } => self.require_chat(chat_id),
            TicketOwner::Executor { executor_id } => {
                if !matches!(&caller.actor, TicketActor::Executor { executor_id: id, .. } if id == executor_id)
                {
                    return Err(ticket_error(
                        ErrorCode::TICKET_VALIDATION_FAILED,
                        "An executor assignment must name the authenticated executor.",
                    ));
                }
                Ok(())
            }
            TicketOwner::User { owner_key } => {
                if !matches!((&caller.actor, &caller.authority), (TicketActor::User { .. }, TicketAuthority::Principal { key, .. }) if key == owner_key)
                {
                    return Err(ticket_error(
                        ErrorCode::TICKET_VALIDATION_FAILED,
                        "A user assignment must name the current authenticated user.",
                    ));
                }
                Ok(())
            }
        }
    }

    fn require_chat(&self, id: &str) -> Result<()> {
        let exists = self
            .options
            .chat_exists
            .as_ref()
            .ok_or(MissingChatAuthority)?;
        if !exists(id) {
            return Err(ticket_error(
                ErrorCode::TICKET_CHAT_NOT_FOUND,
                "The assigned or declared chat no longer exists.",
            ));
        }
        Ok(())
    }
}
