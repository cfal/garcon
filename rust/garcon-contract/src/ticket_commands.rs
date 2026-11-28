//! Ports `common/ticket-commands.ts`.

use garcon_js::OptionalNullable;
use serde::Serialize;
use serde_json::Value;

use crate::{ticket_validation::*, tickets::*};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCreateFields<Project> {
    pub title: String,
    pub description: String,
    pub priority: TicketPriority,
    pub labels: Vec<String>,
    pub assignee: Option<TicketOwner>,
    pub parent_id: Option<String>,
    #[serde(flatten)]
    pub project: Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CreateProject {
    pub project: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkupCreateProject {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TicketPatchStatus {
    Open,
    InProgress,
    InReview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<TicketPriority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub assignee: OptionalNullable<TicketOwner>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub parent_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TicketPatchStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTicketPayload {
    #[serde(flatten)]
    pub target: TicketMutationTarget,
    pub patch: TicketPatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketMutationTarget {
    pub ticket_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketLinkTarget {
    #[serde(flatten)]
    pub target: TicketMutationTarget,
    pub target_id: String,
    pub target_revision: u64,
    pub kind: TicketLinkKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TicketMutationPayload<Project = CreateProject> {
    Create {
        input: TicketCreateFields<Project>,
    },
    Update(UpdateTicketPayload),
    Claim(TicketMutationTarget),
    Release(TicketMutationTarget),
    Reopen(TicketMutationTarget),
    Close {
        #[serde(flatten)]
        target: TicketMutationTarget,
        resolution: TicketResolution,
        #[serde(skip_serializing_if = "Option::is_none")]
        comment: Option<String>,
    },
    Comment {
        ticket_id: String,
        body: String,
    },
    CommentEdit {
        #[serde(flatten)]
        target: TicketMutationTarget,
        comment_id: String,
        body: String,
    },
    CommentDelete {
        #[serde(flatten)]
        target: TicketMutationTarget,
        comment_id: String,
    },
    Link(TicketLinkTarget),
    Unlink(TicketLinkTarget),
}

pub type MarkupTicketMutationPayload = TicketMutationPayload<MarkupCreateProject>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTicketMutationRequest {
    pub request_id: String,
    pub expected_store_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_chat_id: Option<String>,
    pub payload: TicketMutationPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum TicketReadPayload {
    List { query: TicketListQuery },
    Read { query: TicketReadQuery },
    History { query: TicketHistoryQuery },
}

macro_rules! ticket_actions {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum TicketAction { $($variant),+ }

        pub const TICKET_ACTIONS: &[&str] = &[$($wire),+];

        impl TicketAction {
            pub fn from_wire(value: &str) -> Option<Self> {
                match value { $($wire => Some(Self::$variant),)+ _ => None }
            }

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire,)+ }
            }
        }
    };
}

ticket_actions! {
    Create => "create", Update => "update", Claim => "claim", Release => "release",
    Reopen => "reopen", Close => "close", Comment => "comment", CommentEdit => "comment-edit",
    CommentDelete => "comment-delete", Link => "link", Unlink => "unlink", List => "list",
    Read => "read", History => "history",
}

const CREATE_KEYS: &[&str] = &[
    "title",
    "description",
    "project",
    "priority",
    "labels",
    "assignee",
    "parentId",
];
const PATCH_KEYS: &[&str] = &[
    "title",
    "description",
    "project",
    "priority",
    "labels",
    "assignee",
    "parentId",
    "status",
];

pub fn parse_ticket_patch(value: &Value) -> Result<TicketPatch, TicketValidationError> {
    let raw = ticket_record(value, PATCH_KEYS)?;
    if raw.is_empty() {
        return ticket_invalid("A ticket patch must not be empty.");
    }
    Ok(TicketPatch {
        title: raw
            .get("title")
            .map(|v| ticket_title(v).map(str::to_owned))
            .transpose()?,
        description: raw
            .get("description")
            .map(|v| ticket_body(v).map(str::to_owned))
            .transpose()?,
        project: raw
            .get("project")
            .map(|v| ticket_project(v).map(str::to_owned))
            .transpose()?,
        priority: raw.get("priority").map(ticket_priority).transpose()?,
        labels: raw.get("labels").map(ticket_labels).transpose()?,
        assignee: raw
            .get("assignee")
            .map(|v| nullable_owner(v).map(Into::into))
            .transpose()?
            .unwrap_or(OptionalNullable::ABSENT),
        parent_id: raw
            .get("parentId")
            .map(|v| nullable_id(v).map(Into::into))
            .transpose()?
            .unwrap_or(OptionalNullable::ABSENT),
        status: raw
            .get("status")
            .map(|v| match ticket_status(v)? {
                TicketStatus::Open => Ok(TicketPatchStatus::Open),
                TicketStatus::InProgress => Ok(TicketPatchStatus::InProgress),
                TicketStatus::InReview => Ok(TicketPatchStatus::InReview),
                TicketStatus::Closed => ticket_invalid("Use close to close a ticket."),
            })
            .transpose()?,
    })
}

fn nullable_owner(value: &Value) -> Result<Option<TicketOwner>, TicketValidationError> {
    if value.is_null() {
        Ok(None)
    } else {
        ticket_owner(value).map(Some)
    }
}

fn nullable_id(value: &Value) -> Result<Option<String>, TicketValidationError> {
    if value.is_null() {
        Ok(None)
    } else {
        ticket_id(value).map(str::to_owned).map(Some)
    }
}

pub fn parse_markup_ticket_mutation_payload(
    value: &Value,
) -> Result<MarkupTicketMutationPayload, TicketValidationError> {
    parse_mutation(value, |project| Ok(MarkupCreateProject { project }))
}

pub fn parse_ticket_mutation_payload(
    value: &Value,
) -> Result<TicketMutationPayload, TicketValidationError> {
    parse_mutation(value, |project| match project {
        Some(project) => Ok(CreateProject { project }),
        None => ticket_invalid("project must be well-formed Unicode text."),
    })
}

fn parse_mutation<P>(
    value: &Value,
    create_project: impl FnOnce(Option<String>) -> Result<P, TicketValidationError>,
) -> Result<TicketMutationPayload<P>, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "action",
            "input",
            "ticketId",
            "expectedRevision",
            "patch",
            "resolution",
            "comment",
            "body",
            "commentId",
            "targetId",
            "targetRevision",
            "kind",
        ],
    )?;
    let action = value["action"].as_str();
    if action == Some("create") {
        ticket_record(value, &["action", "input"])?;
        let input = ticket_record(&value["input"], CREATE_KEYS)?;
        return Ok(TicketMutationPayload::Create {
            input: TicketCreateFields {
                title: ticket_title(&value["input"]["title"])?.into(),
                description: input
                    .get("description")
                    .map(ticket_body)
                    .transpose()?
                    .unwrap_or_default()
                    .into(),
                priority: input
                    .get("priority")
                    .map(ticket_priority)
                    .transpose()?
                    .unwrap_or(TicketPriority::P2),
                labels: input
                    .get("labels")
                    .map(ticket_labels)
                    .transpose()?
                    .unwrap_or_default(),
                assignee: input
                    .get("assignee")
                    .map(nullable_owner)
                    .transpose()?
                    .flatten(),
                parent_id: input
                    .get("parentId")
                    .map(nullable_id)
                    .transpose()?
                    .flatten(),
                project: create_project(
                    input
                        .get("project")
                        .map(|v| ticket_project(v).map(str::to_owned))
                        .transpose()?,
                )?,
            },
        });
    }
    let id = ticket_id(&value["ticketId"])?.into();
    if action == Some("comment") {
        ticket_record(value, &["action", "ticketId", "body"])?;
        return Ok(TicketMutationPayload::Comment {
            ticket_id: id,
            body: ticket_comment_body(&value["body"])?.into(),
        });
    }
    let target = TicketMutationTarget {
        ticket_id: id,
        expected_revision: ticket_integer(
            &value["expectedRevision"],
            "expectedRevision",
            None,
            None,
        )? as u64,
    };
    const BASE: &[&str] = &["action", "ticketId", "expectedRevision"];
    Ok(match action {
        Some("update") => {
            ticket_record(value, &["action", "ticketId", "expectedRevision", "patch"])?;
            TicketMutationPayload::Update(UpdateTicketPayload {
                target,
                patch: parse_ticket_patch(&value["patch"])?,
            })
        }
        Some("claim" | "release" | "reopen") => {
            ticket_record(value, BASE)?;
            match action {
                Some("claim") => TicketMutationPayload::Claim(target),
                Some("release") => TicketMutationPayload::Release(target),
                _ => TicketMutationPayload::Reopen(target),
            }
        }
        Some("close") => {
            ticket_record(
                value,
                &[
                    "action",
                    "ticketId",
                    "expectedRevision",
                    "resolution",
                    "comment",
                ],
            )?;
            TicketMutationPayload::Close {
                target,
                resolution: raw
                    .get("resolution")
                    .map(ticket_resolution)
                    .transpose()?
                    .unwrap_or(TicketResolution::Done),
                comment: raw
                    .get("comment")
                    .map(|v| ticket_comment_body(v).map(str::to_owned))
                    .transpose()?,
            }
        }
        Some("comment-edit") => {
            ticket_record(
                value,
                &[
                    "action",
                    "ticketId",
                    "expectedRevision",
                    "commentId",
                    "body",
                ],
            )?;
            TicketMutationPayload::CommentEdit {
                target,
                comment_id: ticket_uuid(&value["commentId"], "commentId")?.into(),
                body: ticket_comment_body(&value["body"])?.into(),
            }
        }
        Some("comment-delete") => {
            ticket_record(
                value,
                &["action", "ticketId", "expectedRevision", "commentId"],
            )?;
            TicketMutationPayload::CommentDelete {
                target,
                comment_id: ticket_uuid(&value["commentId"], "commentId")?.into(),
            }
        }
        Some("link" | "unlink") => {
            ticket_record(
                value,
                &[
                    "action",
                    "ticketId",
                    "expectedRevision",
                    "targetId",
                    "targetRevision",
                    "kind",
                ],
            )?;
            let link = TicketLinkTarget {
                target,
                target_id: ticket_id(&value["targetId"])?.into(),
                target_revision: ticket_integer(
                    &value["targetRevision"],
                    "targetRevision",
                    None,
                    None,
                )? as u64,
                kind: ticket_link_kind(&value["kind"])?,
            };
            if action == Some("link") {
                TicketMutationPayload::Link(link)
            } else {
                TicketMutationPayload::Unlink(link)
            }
        }
        _ => return ticket_invalid("Unknown ticket mutation."),
    })
}

pub fn parse_http_ticket_mutation_request(
    value: &Value,
) -> Result<HttpTicketMutationRequest, TicketValidationError> {
    let raw = ticket_record(
        value,
        &["requestId", "expectedStoreId", "fromChatId", "payload"],
    )?;
    Ok(HttpTicketMutationRequest {
        request_id: ticket_uuid(&value["requestId"], "requestId")?.into(),
        expected_store_id: ticket_uuid(&value["expectedStoreId"], "expectedStoreId")?.into(),
        from_chat_id: raw.get("fromChatId").map(ticket_chat_id).transpose()?,
        payload: parse_ticket_mutation_payload(&value["payload"])?,
    })
}
