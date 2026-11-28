//! Ports `common/ticket-stored.ts`.

use garcon_js::json::Opaque;
use serde_json::{Value, json};

use crate::{json::JsonObject, ticket_validation::*, tickets::TicketOwner};

fn record(value: &Value) -> Result<&JsonObject, TicketValidationError> {
    value
        .as_object()
        .ok_or_else(|| TicketValidationError::new("Invalid stored ticket object."))
}

pub fn normalize_stored_ticket_owner(value: &Value) -> Result<TicketOwner, TicketValidationError> {
    let raw = record(value)?;
    if value["kind"] == "user" && raw.contains_key("username") {
        ticket_record(value, &["kind", "username"])?;
        return ticket_owner(&json!({"kind": "user", "ownerKey": value["username"]}));
    }
    ticket_owner(value)
}

fn normalize_ticket(value: &mut Value) -> Result<(), TicketValidationError> {
    record(value)?;
    if let Some(assignee) = value
        .get_mut("assignee")
        .filter(|v| !v.is_null() && **v != "unassigned")
    {
        *assignee = json!(normalize_stored_ticket_owner(assignee)?);
    }
    Ok(())
}

fn field<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Value, TicketValidationError> {
    value
        .get_mut(key)
        .ok_or_else(|| TicketValidationError::new("Invalid stored ticket object."))
}

fn normalize_activity(value: &mut Value) -> Result<(), TicketValidationError> {
    record(value)?;
    if value["action"] == "created" {
        return normalize_ticket(field(value, "ticket")?);
    }
    if let Some(changes) = value.get_mut("changes").and_then(Value::as_array_mut) {
        for change in changes {
            record(change)?;
            if change["field"] == "assignee" {
                for key in ["before", "after"] {
                    let owner = field(change, key)?;
                    if !owner.is_null() {
                        *owner = json!(normalize_stored_ticket_owner(owner)?);
                    }
                }
            }
        }
    }
    Ok(())
}

fn normalize(
    value: &Value,
    apply: impl FnOnce(&mut Value) -> Result<(), TicketValidationError>,
) -> Result<Opaque, TicketValidationError> {
    let mut value = value.clone();
    apply(&mut value)?;
    Ok(value.into())
}

pub fn normalize_stored_ticket(value: &Value) -> Result<Opaque, TicketValidationError> {
    normalize(value, normalize_ticket)
}

pub fn normalize_stored_ticket_activity(value: &Value) -> Result<Opaque, TicketValidationError> {
    normalize(value, normalize_activity)
}

pub fn normalize_stored_ticket_write_result(
    value: &Value,
) -> Result<Opaque, TicketValidationError> {
    normalize(value, |value| {
        record(value)?;
        normalize_ticket(field(value, "ticket")?)?;
        if let Some(related) = value.get_mut("relatedTicket") {
            normalize_ticket(related)?;
        }
        Ok(())
    })
}

pub fn normalize_stored_ticket_request(value: &Value) -> Result<Opaque, TicketValidationError> {
    normalize(value, |value| {
        record(value)?;
        let payload = field(value, "payload")?;
        record(payload)?;
        match payload["action"].as_str() {
            Some("create") => normalize_ticket(field(payload, "input")?),
            Some("update") => normalize_ticket(field(payload, "patch")?),
            _ => Ok(()),
        }
    })
}

fn normalize_outcome(value: &mut Value) -> Result<(), TicketValidationError> {
    record(value)?;
    if let Some(context) = value.get_mut("context") {
        record(context)?;
        if let Some(filters) = context.get_mut("filters") {
            normalize_ticket(filters)?;
        }
    }
    Ok(())
}

pub fn normalize_stored_ticket_outcome(value: &Value) -> Result<Opaque, TicketValidationError> {
    normalize(value, normalize_outcome)
}

pub fn normalize_stored_ticket_result(value: &Value) -> Result<Opaque, TicketValidationError> {
    normalize(value, |value| {
        normalize_outcome(value)?;
        if value["status"] != "ok" {
            return Ok(());
        }
        let command = match value["command"].as_str() {
            Some("read") => "read",
            Some("list") => "list",
            Some("history") => "history",
            _ => "",
        };
        let data = field(value, "data")?;
        record(data)?;
        if command == "read" {
            return normalize_ticket(field(data, "ticket")?);
        }
        if matches!(command, "list" | "history")
            && let Some(items) = data.get_mut("items").and_then(Value::as_array_mut)
        {
            for item in items {
                if command == "list" {
                    normalize_ticket(item)?;
                } else {
                    normalize_activity(item)?;
                }
            }
        }
        Ok(())
    })
}
