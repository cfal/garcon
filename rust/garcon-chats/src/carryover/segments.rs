//! The revision used to identify derived previews. The carryover unit ports
//! `archivedLogicalCount`, `carryOverLayout`, and `assertSegmentBinding`.

use garcon_js::json::stringify;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::registry_contracts::{CarryOverMigrationQuarantine, CarryOverSegmentRef};

pub fn carry_over_revision(
    refs: &[CarryOverSegmentRef],
    quarantine: Option<&CarryOverMigrationQuarantine>,
) -> String {
    if refs.is_empty() && quarantine.is_none() {
        return "carry-v1:0".into();
    }
    // INFALLIBLE: these references contain only strings, integers, and nullable records.
    let mut value = json!({ "refs": refs, "quarantine": quarantine });
    sort_keys(&mut value);
    format!("carry-v5:{:x}", Sha256::digest(stringify(&value)))
}

fn sort_keys(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(sort_keys),
        Value::Object(fields) => {
            // Every key in a segment reference or quarantine is an ASCII field name.
            fields.sort_keys();
            fields.values_mut().for_each(sort_keys);
        }
        _ => {}
    }
}
