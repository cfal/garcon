//! Ports `common/ticket-responses.ts`.

use garcon_js::utf16;
use serde_json::Value;

use crate::{ticket_records::*, ticket_validation::*, tickets::*};

fn version(value: &Value) -> Result<TicketCollectionVersion, TicketValidationError> {
    Ok(TicketCollectionVersion {
        store_id: ticket_uuid(&value["storeId"], "storeId")?.into(),
        collection_revision: ticket_integer(
            &value["collectionRevision"],
            "collectionRevision",
            Some(0.0),
            None,
        )? as u64,
    })
}

fn items<T>(
    value: &Value,
    parse: impl Fn(&Value) -> Result<T, TicketValidationError>,
    max: usize,
) -> Result<Vec<T>, TicketValidationError> {
    let Some(entries) = value.as_array().filter(|a| a.len() <= max) else {
        return ticket_invalid("Invalid ticket response items.");
    };
    entries.iter().map(parse).collect()
}

fn cursor(value: &Value, key: &str) -> Result<Option<u64>, TicketValidationError> {
    if value.get(key) == Some(&Value::Null) {
        Ok(None)
    } else {
        ticket_integer(&value[key], "continuation", None, None).map(|v| Some(v as u64))
    }
}

pub fn parse_ticket_bootstrap(value: &Value) -> Result<TicketBootstrap, TicketValidationError> {
    ticket_record(value, &["storeId", "collectionRevision", "viewerKey"])?;
    let viewer_key = ticket_string(&value["viewerKey"], "viewerKey")?;
    if viewer_key.is_empty() || utf16::len(viewer_key) > 2048 {
        return ticket_invalid("Invalid viewer identity.");
    }
    Ok(TicketBootstrap {
        version: version(value)?,
        viewer_key: viewer_key.into(),
    })
}

pub fn parse_ticket_summary(value: &Value) -> Result<TicketSummary, TicketValidationError> {
    let Some(mut raw) = value.as_object().cloned() else {
        return ticket_invalid("Invalid ticket summary.");
    };
    let blocked_by_count = raw.shift_remove("blockedByCount").unwrap_or(Value::Null);
    let comment_count = raw.shift_remove("commentCount").unwrap_or(Value::Null);
    if raw.contains_key("description") {
        return ticket_invalid("Ticket summary contains a description.");
    }
    raw.insert("description".into(), Value::String(String::new()));
    let Ticket {
        id,
        number,
        revision,
        title,
        description: _,
        project,
        status,
        resolution,
        priority,
        labels,
        assignee,
        parent_id,
        created_at,
        updated_at,
        created_by,
    } = parse_ticket(&Value::Object(raw))?;
    Ok(TicketSummary {
        id,
        number,
        revision,
        title,
        project,
        status,
        resolution,
        priority,
        labels,
        assignee,
        parent_id,
        created_at,
        updated_at,
        created_by,
        blocked_by_count: ticket_integer(
            &blocked_by_count,
            "blockedByCount",
            Some(0.0),
            Some(TICKET_LIMITS.links as f64),
        )? as u64,
        comment_count: ticket_integer(&comment_count, "commentCount", Some(0.0), None)? as u64,
    })
}

pub fn parse_ticket_page(value: &Value) -> Result<TicketPage, TicketValidationError> {
    ticket_record(
        value,
        &["storeId", "collectionRevision", "items", "nextBeforeNumber"],
    )?;
    let entries = items(&value["items"], parse_ticket_summary, TICKET_LIMITS.page)?;
    let next_before_number = cursor(value, "nextBeforeNumber")?;
    if entries.windows(2).any(|w| w[1].number >= w[0].number)
        || next_before_number.is_some()
            && next_before_number != entries.last().map(|entry| entry.number)
    {
        return ticket_invalid("Invalid ticket page ordering or continuation.");
    }
    Ok(TicketPage {
        version: version(value)?,
        items: entries,
        next_before_number,
    })
}

pub fn parse_ticket_comment_view(
    value: &Value,
) -> Result<TicketCommentView, TicketValidationError> {
    let Some(mut raw) = value.as_object().cloned() else {
        return ticket_invalid("Invalid comment view.");
    };
    let can_edit = raw.shift_remove("canEdit").unwrap_or(Value::Null);
    let comment = parse_ticket_comment(&Value::Object(raw))?;
    let can_edit = ticket_boolean(&can_edit)?;
    if can_edit && comment.deleted_at.is_some() {
        return ticket_invalid("A removed comment cannot be editable.");
    }
    Ok(TicketCommentView { comment, can_edit })
}

fn sequence_page<T>(
    value: &Value,
    parse: impl Fn(&Value) -> Result<T, TicketValidationError>,
    identity: impl Fn(&T) -> (&str, u64),
) -> Result<TicketSequencePage<T>, TicketValidationError> {
    ticket_record(
        value,
        &[
            "storeId",
            "collectionRevision",
            "items",
            "nextBeforeSequence",
        ],
    )?;
    let entries = items(&value["items"], parse, TICKET_LIMITS.page)?;
    let next_before_sequence = cursor(value, "nextBeforeSequence")?;
    if entries.windows(2).any(|pair| {
        let (left_id, left_seq) = identity(&pair[0]);
        let (right_id, right_seq) = identity(&pair[1]);
        left_id != right_id || left_seq >= right_seq
    }) || next_before_sequence.is_some()
        && next_before_sequence != entries.first().map(|entry| identity(entry).1)
    {
        return ticket_invalid("Invalid ticket sequence ordering or continuation.");
    }
    Ok(TicketSequencePage {
        version: version(value)?,
        items: entries,
        next_before_sequence,
    })
}

pub fn parse_ticket_comments_page(
    value: &Value,
) -> Result<TicketSequencePage<TicketCommentView>, TicketValidationError> {
    sequence_page(value, parse_ticket_comment_view, |entry| {
        (&entry.comment.ticket_id, entry.comment.sequence)
    })
}

pub fn parse_ticket_history_page(
    value: &Value,
) -> Result<TicketSequencePage<TicketActivity>, TicketValidationError> {
    sequence_page(value, parse_ticket_activity, |entry| {
        (&entry.base.ticket_id, entry.base.sequence)
    })
}

fn parse_link(value: &Value) -> Result<TicketLink, TicketValidationError> {
    ticket_record(value, &["sourceId", "targetId", "kind"])?;
    let source_id = stored_ticket_id(&value["sourceId"])?;
    let target_id = stored_ticket_id(&value["targetId"])?;
    if source_id == target_id {
        return ticket_invalid("Invalid self link.");
    }
    Ok(TicketLink {
        source_id,
        target_id,
        kind: ticket_link_kind(&value["kind"])?,
    })
}

pub fn parse_ticket_detail(value: &Value) -> Result<TicketDetail, TicketValidationError> {
    ticket_record(
        value,
        &[
            "storeId",
            "collectionRevision",
            "ticket",
            "links",
            "comments",
        ],
    )?;
    let ticket_value = &value["ticket"];
    let Some(raw) = ticket_value.as_object() else {
        return ticket_invalid("Invalid ticket detail.");
    };
    let omitted = raw.get("description") == Some(&Value::Null);
    let current = if omitted {
        let mut raw = raw.clone();
        raw.insert("description".into(), Value::String(String::new()));
        parse_ticket(&Value::Object(raw))?
    } else {
        parse_ticket(ticket_value)?
    };
    let version = version(value)?;
    let comments = parse_ticket_comments_page(&value["comments"])?;
    let links = items(&value["links"], parse_link, TICKET_LIMITS.links)?;
    if comments.version != version
        || comments
            .items
            .iter()
            .any(|entry| entry.comment.ticket_id != current.id)
        || links
            .iter()
            .any(|link| link.source_id != current.id && link.target_id != current.id)
    {
        return ticket_invalid("Ticket detail projections disagree.");
    }
    let Ticket {
        id,
        number,
        revision,
        title,
        description,
        project,
        status,
        resolution,
        priority,
        labels,
        assignee,
        parent_id,
        created_at,
        updated_at,
        created_by,
    } = current;
    Ok(TicketDetail {
        version,
        ticket: Ticket {
            id,
            number,
            revision,
            title,
            description: (!omitted).then_some(description),
            project,
            status,
            resolution,
            priority,
            labels,
            assignee,
            parent_id,
            created_at,
            updated_at,
            created_by,
        },
        links,
        comments,
    })
}

pub fn parse_ticket_counts(value: &Value) -> Result<TicketCounts, TicketValidationError> {
    const STATUSES: &[&str] = &["open", "in-progress", "in-review", "closed"];
    ticket_record(value, &["storeId", "collectionRevision", "counts"])?;
    let raw = &value["counts"];
    ticket_record(raw, STATUSES)?;
    let version = version(value)?;
    let counts = TICKET_STATUSES
        .iter()
        .copied()
        .zip(STATUSES)
        .map(|(status, key)| {
            let count = ticket_integer(&raw[*key], key, Some(0.0), None)?;
            Ok((status, count as u64))
        })
        .collect::<Result<_, TicketValidationError>>()?;
    Ok(TicketCounts { version, counts })
}

pub fn parse_ticket_facets(value: &Value) -> Result<TicketFacets, TicketValidationError> {
    ticket_record(value, &["storeId", "collectionRevision", "values"])?;
    Ok(TicketFacets {
        version: version(value)?,
        values: items(
            &value["values"],
            |v| ticket_project(v).map(str::to_owned),
            50,
        )?,
    })
}

pub fn parse_ticket_project_default(
    value: &Value,
) -> Result<TicketProjectDefault, TicketValidationError> {
    ticket_record(value, &["project", "kind"])?;
    let kind = match value["kind"].as_str() {
        Some("repository") => TicketProjectKind::Repository,
        Some("folder") => TicketProjectKind::Folder,
        _ => return ticket_invalid("Invalid project provenance."),
    };
    Ok(TicketProjectDefault {
        project: ticket_project(&value["project"])?.into(),
        kind,
    })
}
