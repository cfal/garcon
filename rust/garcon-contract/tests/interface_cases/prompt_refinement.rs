use garcon_cases::{CaseError, unknown};
use garcon_contract::prompt_refinement::*;
use serde_json::{Value, json};

use crate::helpers::{plain, recorded_cases};

#[test]
fn prompt_refinement_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/prompt-refinement"
        ),
        "common/prompt-refinement.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            let target = |value: &Value| {
                is_prompt_refinement_target(value).ok_or_else(|| CaseError::unhandled(function))
            };
            match function {
                "isPromptRefinementTarget" => {
                    Ok(json!(is_prompt_refinement_target(&value).is_some()))
                }
                "normalizeRefinePromptRequest" => {
                    Ok(plain(normalize_refine_prompt_request(&value)))
                }
                "normalizeRefinePromptResponse" => {
                    let raw_target = unknown(function, args.get(1))?;
                    Ok(plain(normalize_refine_prompt_response(
                        &value,
                        target(&raw_target)?,
                    )))
                }
                "promptRefinementTargetMaxLength" => {
                    Ok(json!(prompt_refinement_target_max_length(target(&value)?)))
                }
                "promptRefinementTargetOutputMaxLength" => Ok(json!(
                    prompt_refinement_target_output_max_length(target(&value)?)
                )),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
