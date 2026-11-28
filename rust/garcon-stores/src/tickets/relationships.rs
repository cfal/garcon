use std::collections::HashSet;

use garcon_contract::{
    error_codes::ErrorCode,
    ticket_validation::ticket_number,
    tickets::{TICKET_LIMITS, Ticket},
};
use rusqlite::{Connection, params};

use super::errors::{Result, ticket_error};
use super::records::require_ticket;

pub(super) fn validate_ticket_parent(database: &Connection, ticket: &Ticket) -> Result<()> {
    let mut visited = HashSet::from([ticket.id.clone()]);
    let mut parent_id = ticket.parent_id.clone();
    let mut ancestor_depth = 0;
    let too_deep = || {
        ticket_error(
            ErrorCode::TICKET_LIMIT_REACHED,
            "Ticket ancestry is too deep.",
        )
    };
    while let Some(id) = parent_id {
        if !visited.insert(id.clone()) {
            return Err(ticket_error(
                ErrorCode::TICKET_RELATIONSHIP_CYCLE,
                "Ticket parents must not form a cycle.",
            ));
        }
        ancestor_depth += 1;
        if ancestor_depth > TICKET_LIMITS.ancestry {
            return Err(too_deep());
        }
        parent_id = require_ticket(database, &id)?.parent_id;
    }
    let descendant_depth: i64 = database.prepare_cached("\n    WITH RECURSIVE descendants(number,depth) AS (\n      SELECT ?,0 UNION ALL\n      SELECT i.number,d.depth+1 FROM tickets i JOIN descendants d ON i.parent_number=d.number WHERE d.depth<=?\n    ) SELECT max(depth) AS depth FROM descendants\n  ")?
        .query_row(params![ticket.number as i64, TICKET_LIMITS.ancestry as i64], |row| row.get(0))?;
    if ancestor_depth as i64 + descendant_depth > TICKET_LIMITS.ancestry as i64 {
        return Err(too_deep());
    }
    Ok(())
}

pub(super) fn require_link_capacity(database: &Connection, source: u64, target: u64) -> Result<()> {
    let mut statement = database.prepare_cached(
        "SELECT count(*) AS count FROM ticket_links WHERE source_number=? OR target_number=?",
    )?;
    for number in [source as i64, target as i64] {
        let count: i64 = statement.query_row([number, number], |row| row.get(0))?;
        if count >= TICKET_LIMITS.links as i64 {
            return Err(ticket_error(
                ErrorCode::TICKET_LIMIT_REACHED,
                "A ticket can have at most 100 links.",
            ));
        }
    }
    Ok(())
}

pub(super) fn require_no_blocking_cycle(
    database: &Connection,
    source_id: &str,
    target_id: &str,
) -> Result<()> {
    let mut statement = database.prepare_cached("\n    WITH RECURSIVE reachable(number) AS (\n      SELECT ? UNION\n      SELECT l.target_number FROM ticket_links l JOIN reachable r ON l.source_number=r.number WHERE l.kind='blocks'\n    ) SELECT number FROM reachable WHERE number=? LIMIT 1\n  ")?;
    if statement.exists([
        ticket_number(target_id)? as i64,
        ticket_number(source_id)? as i64,
    ])? {
        return Err(ticket_error(
            ErrorCode::TICKET_RELATIONSHIP_CYCLE,
            "Blocking links must not form a cycle.",
        ));
    }
    Ok(())
}
