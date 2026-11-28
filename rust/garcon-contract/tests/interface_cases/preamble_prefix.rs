use garcon_cases::{CaseError, markers, text, unknown};
use garcon_contract::preamble_prefix::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::helpers::{plain, recorded_cases};

fn contents<'a>(function: &str, value: &'a Value) -> Result<Vec<&'a str>, CaseError> {
    value
        .as_array()
        .and_then(|values| values.iter().map(Value::as_str).collect())
        .ok_or_else(|| CaseError::undeliverable(format!("{function} contents are not strings")))
}

#[test]
fn preamble_prefix_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/preamble-prefix"
        ),
        "common/preamble-prefix.ts",
        |function, args| match function {
            "preamblePrefixSha256" => {
                let first = args.first();
                if let Some(raw) = first.filter(|raw| markers::kind(raw) == Some("utf16")) {
                    let units = Vec::<u16>::deserialize(&raw["value"])
                        .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                    return Ok(json!(preamble_prefix_sha256(units)));
                }
                let prefix =
                    text(function, first)?.ok_or_else(|| CaseError::unhandled(function))?;
                Ok(json!(preamble_prefix_sha256(prefix.encode_utf16())))
            }
            "renderPreamblePrefix" => {
                let value = unknown(function, args.first())?;
                Ok(json!(render_preamble_prefix(&contents(function, &value)?)))
            }
            "createPreamblePrefix" => {
                let value = unknown(function, args.first())?;
                create_preamble_prefix(&contents(function, &value["contents"])?)
                    .map(plain)
                    .map_err(|error| CaseError::new("RangeError", error.to_string()))
            }
            "parsePreamblePrefixReceipt" => {
                let value = unknown(function, args.first())?;
                Ok(plain(parse_preamble_prefix_receipt(&value)))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
