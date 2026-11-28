//! Ports `server/controller/chats/carryover/segments.ts`.

use garcon_js::json::stringify;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::registry_contracts::{CarryOverMigrationQuarantine, CarryOverSegmentRef};

use super::segment_types::CarryOverSegmentIndex;

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverSegmentLayoutItem<'a> {
    #[serde(rename = "ref")]
    pub reference: &'a CarryOverSegmentRef,
    pub start_sequence: u64,
    pub payload_end_sequence: u64,
    pub boundary_sequence: Option<u64>,
}

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

pub fn archived_logical_count(refs: &[CarryOverSegmentRef]) -> u64 {
    refs.iter()
        .map(|reference| {
            reference.visible_message_count + u64::from(reference.trailing_handoff.is_some())
        })
        .fold(0, u64::saturating_add)
}

pub fn carry_over_layout(refs: &[CarryOverSegmentRef]) -> Vec<CarryOverSegmentLayoutItem<'_>> {
    let mut sequence = 1_u64;
    refs.iter()
        .map(|reference| {
            let start_sequence = sequence;
            let payload_end_sequence =
                (sequence - 1).saturating_add(reference.visible_message_count);
            let boundary_sequence = reference
                .trailing_handoff
                .as_ref()
                .map(|_| payload_end_sequence.saturating_add(1));
            sequence = boundary_sequence
                .unwrap_or(payload_end_sequence)
                .saturating_add(1);
            CarryOverSegmentLayoutItem {
                reference,
                start_sequence,
                payload_end_sequence,
                boundary_sequence,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CarryOverSegmentBindingError {
    #[error("Carryover segment ID mismatch")]
    IdMismatch,
    #[error("Carryover segment count mismatch")]
    CountMismatch,
    #[error("Carryover segment cutoff is outside its artifact")]
    InvalidCutoff,
}

pub fn assert_segment_binding(
    reference: &CarryOverSegmentRef,
    index: &CarryOverSegmentIndex,
) -> Result<(), CarryOverSegmentBindingError> {
    if reference.id != index.id {
        return Err(CarryOverSegmentBindingError::IdMismatch);
    }
    if reference.stored_message_count != index.message_count {
        return Err(CarryOverSegmentBindingError::CountMismatch);
    }
    if reference.visible_message_count > index.message_count {
        return Err(CarryOverSegmentBindingError::InvalidCutoff);
    }
    Ok(())
}
