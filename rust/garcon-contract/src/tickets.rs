//! Ports `common/tickets.ts`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::error_codes::ErrorCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TicketStatus {
    Open,
    InProgress,
    InReview,
    Closed,
}

pub const TICKET_STATUSES: &[TicketStatus] = &[
    TicketStatus::Open,
    TicketStatus::InProgress,
    TicketStatus::InReview,
    TicketStatus::Closed,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketResolution {
    Done,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
#[repr(u8)]
pub enum TicketPriority {
    P0,
    P1,
    P2,
    P3,
}

impl TryFrom<u8> for TicketPriority {
    type Error = &'static str;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::P0),
            1 => Ok(Self::P1),
            2 => Ok(Self::P2),
            3 => Ok(Self::P3),
            _ => Err("Invalid ticket priority"),
        }
    }
}

impl From<TicketPriority> for u8 {
    fn from(priority: TicketPriority) -> Self {
        priority as Self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TicketErrorCode(ErrorCode);

impl TryFrom<ErrorCode> for TicketErrorCode {
    type Error = ErrorCode;

    fn try_from(code: ErrorCode) -> Result<Self, Self::Error> {
        if code.as_str().starts_with("TICKET_") {
            Ok(Self(code))
        } else {
            Err(code)
        }
    }
}

impl From<TicketErrorCode> for ErrorCode {
    fn from(code: TicketErrorCode) -> Self {
        code.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TicketLimits {
    pub title_code_points: usize,
    pub project_bytes: usize,
    pub body_bytes: usize,
    pub label_code_points: usize,
    pub labels: usize,
    pub ref_bytes: usize,
    pub request_bytes: usize,
    pub http_bytes: usize,
    pub markup_bytes: usize,
    pub page: usize,
    pub default_page: usize,
    pub links: usize,
    pub ancestry: usize,
}

pub const TICKET_LIMITS: TicketLimits = TicketLimits {
    title_code_points: 240,
    project_bytes: 4096,
    body_bytes: 48 * 1024,
    label_code_points: 64,
    labels: 20,
    ref_bytes: 128,
    request_bytes: 64 * 1024,
    http_bytes: 1024 * 1024,
    markup_bytes: 48 * 1024,
    page: 100,
    default_page: 50,
    links: 100,
    ancestry: 100,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TicketOwner {
    Executor { executor_id: String },
    Chat { chat_id: String },
    User { owner_key: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketChatProvenance {
    Observed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketPrincipalMode {
    Authenticated,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TicketActor {
    Executor {
        executor_id: String,
        declared_chat_id: Option<String>,
    },
    Chat {
        chat_id: String,
        provenance: TicketChatProvenance,
    },
    User {
        username: String,
        principal_mode: TicketPrincipalMode,
        declared_chat_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketSource {
    pub chat_id: String,
    pub transcript_view_id: String,
    pub ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket<Description = String> {
    pub id: String,
    pub number: u64,
    pub revision: u64,
    pub title: String,
    pub description: Description,
    pub project: String,
    pub status: TicketStatus,
    pub resolution: Option<TicketResolution>,
    pub priority: TicketPriority,
    pub labels: Vec<String>,
    pub assignee: Option<TicketOwner>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: TicketActor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketComment {
    pub id: String,
    pub ticket_id: String,
    pub sequence: u64,
    pub revision: u64,
    pub body: Option<String>,
    pub deleted_at: Option<String>,
    pub author: TicketActor,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCommentView {
    #[serde(flatten)]
    pub comment: TicketComment,
    pub can_edit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketLinkKind {
    Blocks,
    Related,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketLink {
    pub source_id: String,
    pub target_id: String,
    pub kind: TicketLinkKind,
}

macro_rules! ticket_fields {
    ($($variant:ident($value:ty)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum TicketField { $($variant),+ }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(tag = "field", rename_all = "camelCase")]
        pub enum TicketFieldChange { $($variant { before: $value, after: $value }),+ }
    };
}

ticket_fields! {
    Title(String), Description(String), Project(String), Status(TicketStatus),
    Resolution(Option<TicketResolution>), Priority(TicketPriority), Labels(Vec<String>),
    Assignee(Option<TicketOwner>), ParentId(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketActivityBase {
    pub sequence: u64,
    pub ticket_id: String,
    pub at: String,
    pub actor: TicketActor,
    pub source: Option<TicketSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketActivity {
    #[serde(flatten)]
    pub base: TicketActivityBase,
    #[serde(flatten)]
    pub action: TicketActivityAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum TicketActivityAction {
    Created { ticket: Box<Ticket> },
    Updated(TicketChanges),
    Claimed(TicketChanges),
    Released(TicketChanges),
    Closed(TicketChanges),
    Reopened(TicketChanges),
    CommentAdded(TicketCommentChange),
    CommentEdited(TicketCommentChange),
    CommentRemoved(TicketCommentChange),
    Linked(#[serde(serialize_with = "serialize_activity_link")] TicketLink),
    Unlinked(#[serde(serialize_with = "serialize_activity_link")] TicketLink),
}

fn serialize_activity_link<S: Serializer>(
    link: &TicketLink,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ActivityLink<'a> {
        kind: TicketLinkKind,
        source_id: &'a str,
        target_id: &'a str,
    }
    ActivityLink {
        kind: link.kind,
        source_id: &link.source_id,
        target_id: &link.target_id,
    }
    .serialize(serializer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketChanges {
    pub changes: Vec<TicketFieldChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCommentChange {
    pub comment_id: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketSummary {
    pub id: String,
    pub number: u64,
    pub revision: u64,
    pub title: String,
    pub project: String,
    pub status: TicketStatus,
    pub resolution: Option<TicketResolution>,
    pub priority: TicketPriority,
    pub labels: Vec<String>,
    pub assignee: Option<TicketOwner>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: TicketActor,
    pub blocked_by_count: u64,
    pub comment_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketUnassigned {
    Unassigned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TicketAssignee {
    Owner(TicketOwner),
    Unassigned(TicketUnassigned),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TicketStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_closed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<TicketPriority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<TicketAssignee>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_collection_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketReadQuery {
    pub ticket_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_description: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_comment_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_collection_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCommentsQuery {
    pub ticket_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_collection_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketHistoryQuery {
    pub ticket_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCollectionVersion {
    pub store_id: String,
    pub collection_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketPage {
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub items: Vec<TicketSummary>,
    pub next_before_number: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketSequencePage<T> {
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub items: Vec<T>,
    pub next_before_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketDetail {
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub ticket: Ticket<Option<String>>,
    pub links: Vec<TicketLink>,
    pub comments: TicketSequencePage<TicketCommentView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketWriteResult {
    pub success: bool,
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub ticket: Ticket,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<TicketComment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_ticket: Option<Ticket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketCounts {
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub counts: IndexMap<TicketStatus, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketFacets {
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketBootstrap {
    #[serde(flatten)]
    pub version: TicketCollectionVersion,
    pub viewer_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketProjectKind {
    Repository,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketProjectDefault {
    pub project: String,
    pub kind: TicketProjectKind,
}

pub fn ticket_owner_key(owner: &TicketOwner) -> String {
    match owner {
        TicketOwner::Executor { executor_id } => format!("executor:{executor_id}"),
        TicketOwner::Chat { chat_id } => format!("chat:{chat_id}"),
        TicketOwner::User { owner_key } => format!("user:{owner_key}"),
    }
}

pub fn ticket_assignee_query(owner: &TicketAssignee) -> String {
    match owner {
        TicketAssignee::Owner(owner) => ticket_owner_key(owner),
        TicketAssignee::Unassigned(_) => "unassigned".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::json::from_str;

    #[test]
    fn encodes_assignees_without_conflating_colon_or_unicode_usernames() {
        assert_eq!(
            ticket_assignee_query(&TicketAssignee::Unassigned(TicketUnassigned::Unassigned)),
            "unassigned"
        );
        assert_eq!(
            ticket_assignee_query(&TicketAssignee::Owner(TicketOwner::Chat {
                chat_id: "1000000000000001".into()
            })),
            "chat:1000000000000001"
        );
        assert_eq!(
            ticket_assignee_query(&TicketAssignee::Owner(TicketOwner::User {
                owner_key: "user:\u{03bb}".into()
            })),
            "user:user:\u{03bb}"
        );
        assert_eq!(
            ticket_owner_key(&TicketOwner::Executor {
                executor_id: "local".into()
            }),
            "executor:local"
        );
    }

    #[test]
    fn round_trips_typed_domain_records_and_rejects_incorrect_change_types() {
        let wire = r#"{"sequence":1,"ticketId":"G-1","at":"2026-01-01T00:00:00.000Z","actor":{"kind":"user","username":"local","principalMode":"local","declaredChatId":null},"source":null,"action":"updated","changes":[{"field":"priority","before":2,"after":1}]}"#;
        let activity: TicketActivity = from_str(wire).unwrap();
        assert_eq!(serde_json::to_string(&activity).unwrap(), wire);
        assert!(
            from_str::<TicketActivity>(&wire.replace(r#""after":1"#, r#""after":"High""#)).is_err()
        );
        assert!(from_str::<TicketActivity>(&wire.replace(r#""after":1"#, r#""after":4"#)).is_err());
    }
}
