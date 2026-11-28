use garcon_cases::{CaseError, text, unknown};
use garcon_contract::snippets::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    bun::bun_fixtures,
    helpers::{plain, recorded_cases},
};

#[test]
fn snippets_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/snippets"),
        "common/snippets.ts",
        |function, args| {
            let string_arg = |index| {
                text(function, args.get(index))?.ok_or_else(|| CaseError::unhandled(function))
            };
            let value = unknown(function, args.first())?;
            match function {
                "compareSnippetShortNames" => Ok(json!(compare_snippet_short_names(
                    string_arg(0)?,
                    string_arg(1)?
                ) as i8)),
                "hasSameSnippetTemplateTokenSignature" => Ok(json!(
                    has_same_snippet_template_token_signature(string_arg(0)?, string_arg(1)?)
                )),
                "isSnippetShortName" => Ok(json!(is_snippet_short_name(&value))),
                "isSnippetsInvalidationReason" => {
                    Ok(json!(is_snippets_invalidation_reason(&value)))
                }
                "normalizeExpandSnippetRequest" => {
                    Ok(plain(normalize_expand_snippet_request(&value)))
                }
                "normalizeExpandSnippetResponse" => {
                    Ok(plain(normalize_expand_snippet_response(&value)))
                }
                "normalizeSnippet" => Ok(plain(normalize_snippet(&value))),
                "normalizeSnippetArgumentsInput" => {
                    Ok(plain(normalize_snippet_arguments_input(&value)))
                }
                "normalizeSnippetDefinitionInput" => {
                    Ok(plain(normalize_snippet_definition_input(&value)))
                }
                "normalizeSnippetsMutationResponse" => {
                    Ok(plain(normalize_snippets_mutation_response(&value)))
                }
                "normalizeSnippetsSnapshot" => Ok(plain(normalize_snippets_snapshot(&value))),
                "snippetTemplateTokenSignature" => {
                    Ok(json!(snippet_template_token_signature(string_arg(0)?)))
                }
                "snippetTemplateUsesArguments" => {
                    Ok(json!(snippet_template_uses_arguments(string_arg(0)?)))
                }
                "snippetTemplateUsesChatId" => {
                    Ok(json!(snippet_template_uses_chat_id(string_arg(0)?)))
                }
                "snippetTemplateUsesProjectPath" => {
                    Ok(json!(snippet_template_uses_project_path(string_arg(0)?)))
                }
                "sortSnippetsByShortName" => {
                    let snippets = Vec::<Snippet>::deserialize(value.as_ref())
                        .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                    Ok(json!(sort_snippets_by_short_name(&snippets)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

#[test]
fn snippet_generator_and_record_boundary_match_bun() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixtures {
        tokens: Vec<(String, Value)>,
        inherited: (Value, Value),
        cross_realm: (Value, Value),
    }

    let output = bun_fixtures("snippet-fixtures.ts");
    let fixtures: Fixtures = garcon_js::json::from_str(&output).unwrap();
    assert_eq!(fixtures.tokens.len(), 6);
    for (template, expected) in fixtures.tokens {
        assert_eq!(
            json!(match_snippet_template_tokens(&template).collect::<Vec<_>>()),
            expected,
            "{template}"
        );
    }
    let (input, expected) = fixtures.inherited;
    assert_eq!(plain(normalize_snippet_definition_input(&input)), expected);
    let (input, expected) = fixtures.cross_realm;
    assert_eq!(plain(normalize_snippets_snapshot(&input)), expected);
}
