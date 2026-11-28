use garcon_cases::{CaseError, markers, text, unknown};
use garcon_contract::{
    preambles::*,
    template_tokens::{RuntimeTemplateValues, TemplateExpansionError},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::helpers::{plain, recorded_cases};

#[test]
fn preambles_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/preambles"),
        "common/preambles.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            match function {
                "isPreambleId" => Ok(json!(is_preamble_id(&value))),
                "normalizeOrderedPreambleIds" => Ok(plain(normalize_ordered_preamble_ids(&value))),
                "normalizePreambleSelectionChoice" => {
                    Ok(plain(normalize_preamble_selection_choice(&value)))
                }
                "isPreambleSelectionUnavailableReason" => Ok(json!(
                    is_preamble_selection_unavailable_reason(&value).is_some()
                )),
                "normalizePreamblesMutationResponse" => {
                    Ok(plain(normalize_preambles_mutation_response(&value)))
                }
                "isPreambleBoundaryKind" => Ok(json!(is_preamble_boundary_kind(&value).is_some())),
                "normalizePendingPreambleBoundary" => {
                    Ok(plain(normalize_pending_preamble_boundary(&value)))
                }
                "normalizeChatPreambleSelection" => {
                    Ok(plain(normalize_chat_preamble_selection(&value)))
                }
                "normalizePreambleSelectionReference" => {
                    Ok(plain(normalize_preamble_selection_reference(&value)))
                }
                "normalizeUnavailablePreambleSelectionReference" => Ok(plain(
                    normalize_unavailable_preamble_selection_reference(&value),
                )),
                "normalizePreambleSelectionProjection" => {
                    Ok(plain(normalize_preamble_selection_projection(&value)))
                }
                "isPreamblesInvalidationReason" => {
                    Ok(json!(is_preambles_invalidation_reason(&value)))
                }
                "normalizePreambleTitle" => Ok(plain(normalize_preamble_title(&value))),
                "normalizePreambleScope" => Ok(plain(normalize_preamble_scope(&value))),
                "normalizePreambleDefinitionInput" => {
                    Ok(plain(normalize_preamble_definition_input(&value)))
                }
                "normalizePreamble" => Ok(plain(normalize_preamble(&value))),
                "normalizePreamblesSnapshot" => Ok(plain(normalize_preambles_snapshot(&value))),
                "renderPreambleContent" => {
                    let content = text(function, args.first())?
                        .ok_or_else(|| CaseError::unhandled(function))?;
                    let values = RuntimeTemplateValues::<String>::deserialize(
                        unknown(function, args.get(1))?.as_ref(),
                    )
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                    render_preamble_content(content, &values)
                        .map(|rendered| json!(rendered))
                        .map_err(|error| match error {
                            TemplateExpansionError::TooLong(error) => {
                                CaseError::new("TemplateExpansionTooLongError", error.to_string())
                                    .with_property("maxLength", markers::number(error.max_length))
                            }
                            TemplateExpansionError::MissingValue => {
                                CaseError::new("TypeError", error.to_string())
                            }
                        })
                }
                "samePreambleBoundary" => {
                    let read = |value: &Value| {
                        PendingPreambleBoundary::deserialize(value)
                            .map_err(|error| CaseError::undeliverable(error.to_string()))
                    };
                    let left = read(value.as_ref())?;
                    let right = read(unknown(function, args.get(1))?.as_ref())?;
                    Ok(json!(same_preamble_boundary(&left, &right)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
