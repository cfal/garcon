use garcon_cases::{CaseError, text, unknown};
use garcon_contract::tags::{
    append_normalized_unique_tag, finalize_normalized_tags, normalize_tag_slug, normalize_tags,
};
use serde_json::json;

use crate::helpers::recorded_cases;

#[test]
fn tags_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/tags"),
        "common/tags.ts",
        |function, args| match function {
            "normalizeTagSlug" => {
                let raw =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                Ok(json!(normalize_tag_slug(raw)))
            }
            "appendNormalizedUniqueTag" | "finalizeNormalizedTags" => {
                let raw =
                    text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function))?;
                let tags: Vec<String> =
                    serde_json::from_value(unknown(function, args.first())?.into_owned())
                        .map_err(|_| CaseError::unhandled(function))?;
                let result = if function == "appendNormalizedUniqueTag" {
                    append_normalized_unique_tag(&tags, raw)
                } else {
                    finalize_normalized_tags(&tags, raw)
                };
                Ok(json!(result))
            }
            "normalizeTags" => {
                let value = unknown(function, args.first())?;
                let tags = value
                    .as_array()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                Ok(json!(normalize_tags(tags)))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
