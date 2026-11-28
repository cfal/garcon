use garcon_cases::{CaseError, text, unknown};
use garcon_contract::transcript_seed::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::helpers::{plain, recorded_cases};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    agent_session_id: String,
    placement: NativeSeedPlacement,
    prefix: String,
    format: Option<NativeSeedFormat>,
}

fn result(value: Result<Option<NativeSeedReceipt>, MissingNativeSeedSessionId>) -> Value {
    match value {
        Ok(value) => plain(value),
        Err(error) => {
            json!({"$":"error", "name":"Error", "message":error.to_string(), "properties":{}})
        }
    }
}

#[test]
fn transcript_seed_receipt_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/transcript-seed-receipts"
        ),
        "common/transcript-seed.ts (receipts)",
        |function, args| {
            let value = unknown(function, args.first())?;
            let session_id =
                || text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function));
            let invalid = |_| CaseError::unhandled(function);
            Ok(match function {
                "createNativeSeedReceipt" => {
                    let input: CreateInput =
                        garcon_js::json::from_str(&value.to_string()).map_err(invalid)?;
                    result(
                        create_native_seed_receipt(NativeSeedReceiptInput {
                            agent_session_id: &input.agent_session_id,
                            placement: input.placement,
                            prefix: &input.prefix,
                            format: input.format,
                        })
                        .map(Some),
                    )
                }
                "parseNativeSeedReceipt" => plain(parse_native_seed_receipt(&value)),
                "receiptForCarriedContext" => {
                    let context: Option<CarriedContext> =
                        garcon_js::json::from_str(&value.to_string()).map_err(invalid)?;
                    let placement = unknown(function, args.get(2))?;
                    let placement =
                        garcon_js::json::from_str(&placement.to_string()).map_err(invalid)?;
                    result(receipt_for_carried_context(
                        context.as_ref(),
                        session_id()?,
                        placement,
                    ))
                }
                "retargetNativeSeedReceipt" => {
                    let receipt = if value.is_null() {
                        None
                    } else {
                        Some(
                            parse_native_seed_receipt(&value)
                                .ok_or_else(|| CaseError::unhandled(function))?,
                        )
                    };
                    result(retarget_native_seed_receipt(
                        receipt.as_ref(),
                        session_id()?,
                    ))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
