use garcon_cases::{CaseError, unknown};
use garcon_contract::tickets::{ticket_assignee_query, ticket_owner_key};
use serde_json::{Value, json};

use crate::helpers::recorded_cases;

#[test]
fn ticket_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/tickets"),
        "common/tickets.ts",
        |function, args| {
            let value = unknown(function, args.first())?.into_owned();
            match function {
                "ticketOwnerKey" => {
                    let owner = decode(function, value)?;
                    Ok(json!(ticket_owner_key(&owner)))
                }
                "ticketAssigneeQuery" => {
                    let owner = decode(function, value)?;
                    Ok(json!(ticket_assignee_query(&owner)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

fn decode<T: serde::de::DeserializeOwned>(function: &str, value: Value) -> Result<T, CaseError> {
    serde_json::from_value(value).map_err(|_| CaseError::unhandled(function))
}
