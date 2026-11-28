use garcon_base::stored_json::parse_stored_json;
use garcon_contract::{
    error_codes::ErrorCode,
    ticket_records::parse_ticket_activity,
    ticket_stored::normalize_stored_ticket_activity,
    ticket_validation::{
        MAX_SAFE_TICKET_INTEGER, TICKET_ID_PREFIX, format_ticket_id, ticket_link_kind,
        ticket_number, ticket_status,
    },
    tickets::{
        TICKET_LIMITS, TICKET_STATUSES, Ticket, TicketActivity, TicketAssignee,
        TicketCollectionVersion, TicketCommentView, TicketCommentsQuery, TicketCounts,
        TicketDetail, TicketFacets, TicketHistoryQuery, TicketLink, TicketListQuery, TicketPage,
        TicketReadQuery, TicketSequencePage, TicketSummary, ticket_owner_key,
    },
};
use rusqlite::{Connection, params_from_iter, types::Value as Sql};
use serde::Serialize;
use serde_json::Value;

use super::contracts::{TicketAuthority, ticket_authority_key};
use super::errors::{Result, ticket_error};
use super::records::{
    StoredCommentRow, collection_revision, decode_comment, decode_ticket,
    require_collection_revision, require_ticket, status_name,
};

fn oversized() -> Box<dyn std::error::Error> {
    ticket_error(
        ErrorCode::TICKET_RESULT_TOO_LARGE,
        "Ticket content exceeds the response limit. Request less content or use another transport.",
    )
}

fn pack_ticket_items<T, R: Serialize>(
    candidates: &[T],
    limit: usize,
    build: impl Fn(&[T], bool) -> R,
    budget: usize,
) -> Result<R> {
    if serde_json::to_vec(&build(&[], false))?.len() > budget {
        return Err(oversized());
    }
    let mut count = 0;
    for next in 1..=limit.min(candidates.len()) {
        if serde_json::to_vec(&build(&candidates[..next], candidates.len() > next))?.len() > budget
        {
            if count == 0 {
                return Err(oversized());
            }
            break;
        }
        count = next;
    }
    Ok(build(&candidates[..count], candidates.len() > count))
}

const UNRESOLVED_BLOCKERS: &str = "SELECT count(*) FROM ticket_links bl JOIN tickets blocker ON blocker.number=bl.source_number\n  WHERE bl.target_number=i.number AND bl.kind='blocks' AND NOT (blocker.status='closed' AND blocker.resolution='done')";

fn literal_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

#[derive(Default)]
struct Filters {
    conditions: Vec<String>,
    values: Vec<Sql>,
}

impl Filters {
    fn add(&mut self, condition: &str, value: Sql) {
        self.conditions.push(condition.into());
        self.values.push(value);
    }
}

fn list_filter(query: &TicketListQuery) -> (String, Vec<Sql>) {
    let mut filter = Filters::default();
    if let Some(project) = &query.project {
        filter.add("i.project=?", Sql::Text(project.clone()));
    }
    if let Some(status) = query.status {
        filter.add("i.status=?", Sql::Text(status_name(status).into()));
    } else if query.include_closed != Some(true) {
        filter.conditions.push("i.status<>'closed'".into());
    }
    if let Some(priority) = query.priority {
        filter.add("i.priority=?", Sql::Integer(u8::from(priority).into()));
    }
    if let Some(label) = &query.label {
        filter.add(
            "EXISTS(SELECT 1 FROM ticket_labels l WHERE l.ticket_number=i.number AND l.label=?)",
            Sql::Text(label.clone()),
        );
    }
    match &query.assignee {
        Some(TicketAssignee::Unassigned(_)) => {
            filter.conditions.push("i.assignee_key IS NULL".into())
        }
        Some(TicketAssignee::Owner(owner)) => {
            filter.add("i.assignee_key=?", Sql::Text(ticket_owner_key(owner)))
        }
        None => {}
    }
    if let Some(ready) = query.ready {
        let predicate =
            format!("(i.status='open' AND i.assignee_key IS NULL AND ({UNRESOLVED_BLOCKERS})=0)");
        filter.conditions.push(if ready {
            predicate
        } else {
            format!("NOT {predicate}")
        });
    }
    if let Some(text) = &query.query {
        filter.conditions.push(format!("(instr(lower(json_extract(i.payload_json,'$.title')), lower(?))>0\n      OR instr(lower(json_extract(i.payload_json,'$.description')), lower(?))>0 OR '{TICKET_ID_PREFIX}'||i.number=?)"));
        filter
            .values
            .extend((0..3).map(|_| Sql::Text(text.clone())));
    }
    if let Some(before) = query.before_number {
        filter.add("i.number<?", Sql::Integer(before as i64));
    }
    let sql = if filter.conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filter.conditions.join(" AND "))
    };
    (sql, filter.values)
}

fn version(store_id: &str, collection_revision: u64) -> TicketCollectionVersion {
    TicketCollectionVersion {
        store_id: store_id.into(),
        collection_revision,
    }
}

fn page_limit(limit: Option<u64>) -> usize {
    limit.map_or(TICKET_LIMITS.default_page, |limit| limit as usize)
}

pub(super) fn list_tickets(
    database: &Connection,
    store_id: &str,
    query: &TicketListQuery,
    budget: usize,
) -> Result<TicketPage> {
    let version = version(
        store_id,
        require_collection_revision(database, query.expected_collection_revision)?,
    );
    let (filter, mut bindings) = list_filter(query);
    let limit = page_limit(query.limit);
    bindings.push(Sql::Integer(limit as i64 + 1));
    let sql = format!(
        "\n    SELECT i.*, ({UNRESOLVED_BLOCKERS}) AS blocked_count,\n      (SELECT count(*) FROM ticket_comments c WHERE c.ticket_number=i.number AND c.deleted_at IS NULL) AS comment_count\n    FROM tickets i {filter} ORDER BY i.number DESC LIMIT ?\n  "
    );
    let mut statement = database.prepare_cached(&sql)?;
    let mut rows = statement.query(params_from_iter(bindings))?;
    let mut summaries = Vec::new();
    while let Some(row) = rows.next()? {
        let t = decode_ticket(row)?;
        summaries.push(TicketSummary {
            id: t.id,
            number: t.number,
            revision: t.revision,
            title: t.title,
            project: t.project,
            status: t.status,
            resolution: t.resolution,
            priority: t.priority,
            labels: t.labels,
            assignee: t.assignee,
            parent_id: t.parent_id,
            created_at: t.created_at,
            updated_at: t.updated_at,
            created_by: t.created_by,
            blocked_by_count: row.get::<_, i64>("blocked_count")? as u64,
            comment_count: row.get::<_, i64>("comment_count")? as u64,
        });
    }
    pack_ticket_items(
        &summaries,
        limit,
        |items, more| TicketPage {
            version: version.clone(),
            items: items.to_vec(),
            next_before_number: if more {
                items.last().map(|item| item.number)
            } else {
                None
            },
        },
        budget,
    )
}

pub(super) fn count_tickets(
    database: &Connection,
    store_id: &str,
    query: &TicketListQuery,
) -> Result<TicketCounts> {
    let version = version(
        store_id,
        require_collection_revision(database, query.expected_collection_revision)?,
    );
    let (filter, bindings) = list_filter(query);
    let mut statement = database.prepare_cached(&format!(
        "SELECT i.status,count(*) AS count FROM tickets i {filter} GROUP BY i.status"
    ))?;
    let mut rows = statement.query(params_from_iter(bindings))?;
    let mut result = TicketCounts {
        version,
        counts: TICKET_STATUSES.iter().map(|status| (*status, 0)).collect(),
    };
    while let Some(row) = rows.next()? {
        let status = ticket_status(&Value::String(row.get(0)?))?;
        result.counts.insert(status, row.get::<_, i64>(1)? as u64);
    }
    Ok(result)
}

fn comment_candidates(
    database: &Connection,
    query: &TicketCommentsQuery,
    authority: &TicketAuthority,
) -> Result<Vec<TicketCommentView>> {
    let mut statement = database.prepare_cached("\n    SELECT * FROM ticket_comments WHERE ticket_number=? AND sequence<? ORDER BY sequence DESC LIMIT ?\n  ")?;
    let mut rows = statement.query([
        ticket_number(&query.ticket_id)? as i64,
        query
            .before_sequence
            .unwrap_or(MAX_SAFE_TICKET_INTEGER as u64) as i64,
        page_limit(query.limit) as i64 + 1,
    ])?;
    let authority_key = ticket_authority_key(authority);
    let mut views = Vec::new();
    while let Some(row) = rows.next()? {
        let row = StoredCommentRow::read(row)?;
        let comment = decode_comment(&row)?;
        views.push(TicketCommentView {
            comment,
            can_edit: row.deleted_at.is_none() && row.authority_key == authority_key,
        });
    }
    Ok(views)
}

fn sequence_page<T: Clone>(
    version: &TicketCollectionVersion,
    items: &[T],
    more: bool,
    sequence: impl Fn(&T) -> u64,
) -> TicketSequencePage<T> {
    TicketSequencePage {
        version: version.clone(),
        items: items.iter().rev().cloned().collect(),
        next_before_sequence: if more {
            items.last().map(sequence)
        } else {
            None
        },
    }
}

pub(super) fn read_ticket_comments(
    database: &Connection,
    store_id: &str,
    query: &TicketCommentsQuery,
    authority: &TicketAuthority,
    budget: usize,
) -> Result<TicketSequencePage<TicketCommentView>> {
    let version = version(
        store_id,
        require_collection_revision(database, query.expected_collection_revision)?,
    );
    require_ticket(database, &query.ticket_id)?;
    pack_ticket_items(
        &comment_candidates(database, query, authority)?,
        page_limit(query.limit),
        |items, more| sequence_page(&version, items, more, |item| item.comment.sequence),
        budget,
    )
}

pub(super) fn read_ticket_detail(
    database: &Connection,
    store_id: &str,
    query: &TicketReadQuery,
    authority: &TicketAuthority,
    budget: usize,
) -> Result<TicketDetail> {
    let version = version(
        store_id,
        require_collection_revision(database, query.expected_collection_revision)?,
    );
    let t = require_ticket(database, &query.ticket_id)?;
    let ticket = Ticket {
        id: t.id,
        number: t.number,
        revision: t.revision,
        title: t.title,
        description: (query.include_description != Some(false)).then_some(t.description),
        project: t.project,
        status: t.status,
        resolution: t.resolution,
        priority: t.priority,
        labels: t.labels,
        assignee: t.assignee,
        parent_id: t.parent_id,
        created_at: t.created_at,
        updated_at: t.updated_at,
        created_by: t.created_by,
    };
    let mut statement = database.prepare_cached("SELECT * FROM ticket_links WHERE source_number=? OR target_number=? ORDER BY source_number,target_number,kind")?;
    let mut rows = statement.query([ticket.number as i64, ticket.number as i64])?;
    let mut links = Vec::new();
    while let Some(row) = rows.next()? {
        links.push(TicketLink {
            source_id: format_ticket_id(row.get("source_number")?)?,
            target_id: format_ticket_id(row.get("target_number")?)?,
            kind: ticket_link_kind(&Value::String(row.get("kind")?))?,
        });
    }
    let limit = page_limit(query.comment_limit);
    let candidates = if limit == 0 {
        Vec::new()
    } else {
        comment_candidates(
            database,
            &TicketCommentsQuery {
                ticket_id: query.ticket_id.clone(),
                limit: query.comment_limit,
                before_sequence: query.before_comment_sequence,
                expected_collection_revision: None,
            },
            authority,
        )?
    };
    pack_ticket_items(
        &candidates,
        limit,
        |items, more| TicketDetail {
            version: version.clone(),
            ticket: ticket.clone(),
            links: links.clone(),
            comments: sequence_page(&version, items, more, |view| view.comment.sequence),
        },
        budget,
    )
}

pub(super) fn read_ticket_history(
    database: &Connection,
    store_id: &str,
    query: &TicketHistoryQuery,
    budget: usize,
) -> Result<TicketSequencePage<TicketActivity>> {
    require_ticket(database, &query.ticket_id)?;
    let version = version(store_id, collection_revision(database)?);
    let limit = page_limit(query.limit);
    let mut statement = database.prepare_cached("\n    SELECT sequence,payload_json FROM ticket_activity WHERE ticket_number=? AND sequence<? ORDER BY sequence DESC LIMIT ?\n  ")?;
    let mut rows = statement.query([
        ticket_number(&query.ticket_id)? as i64,
        query
            .before_sequence
            .unwrap_or(MAX_SAFE_TICKET_INTEGER as u64) as i64,
        limit as i64 + 1,
    ])?;
    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        let payload: String = row.get("payload_json")?;
        let parsed = parse_stored_json(&payload, "Ticket activity")?;
        let activity =
            parse_ticket_activity(normalize_stored_ticket_activity(&parsed)?.as_value())?;
        if activity.base.sequence as i64 != row.get::<_, i64>("sequence")?
            || activity.base.ticket_id != query.ticket_id
        {
            return Err("Inconsistent ticket activity.".into());
        }
        events.push(activity);
    }
    pack_ticket_items(
        &events,
        limit,
        |items, more| sequence_page(&version, items, more, |item| item.base.sequence),
        budget,
    )
}

#[derive(Clone, Copy)]
pub enum Facet {
    Project,
    Label,
}

pub(super) fn ticket_facets(
    database: &Connection,
    store_id: &str,
    field: Facet,
    prefix: &str,
) -> Result<TicketFacets> {
    let sql = match field {
        Facet::Project => {
            "SELECT DISTINCT project AS value FROM tickets WHERE project LIKE ? ESCAPE '\\' ORDER BY project LIMIT 50"
        }
        Facet::Label => {
            "SELECT DISTINCT label AS value FROM ticket_labels WHERE label LIKE ? ESCAPE '\\' ORDER BY label LIMIT 50"
        }
    };
    let mut statement = database.prepare_cached(sql)?;
    let values = statement
        .query_map([format!("{}%", literal_like(prefix))], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(TicketFacets {
        version: version(store_id, collection_revision(database)?),
        values,
    })
}
