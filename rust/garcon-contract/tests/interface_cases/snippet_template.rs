use garcon_cases::{CaseError, text, unknown};
use garcon_contract::{snippet_template::*, template_tokens::RuntimeTemplateValues};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::helpers::recorded_cases;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateValues {
    arguments: String,
    project_path: String,
    context: Option<RuntimeTemplateValues>,
}

fn expansion_error(error: SnippetExpansionError) -> Value {
    json!({"$":"error", "name":"SnippetExpansionError", "message":error.to_string(), "properties":{"code":error.code()}})
}

fn boundary_error(error: ScheduledSnippetBoundaryError) -> Value {
    json!({"$":"error", "name":"ScheduledSnippetBoundaryError", "message":error.to_string(), "properties":{"code":error.code()}})
}

#[test]
fn snippet_template_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/snippet-template"
        ),
        "common/snippet-template.ts",
        |function, args| {
            let input = || -> Result<_, CaseError> {
                let template =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                let values = TemplateValues::deserialize(unknown(function, args.get(1))?.as_ref())
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                Ok((template, values))
            };
            let result = match function {
                "expandSnippetTemplate" => {
                    let (template, input) = input()?;
                    expand_snippet_template(
                        template,
                        &SnippetTemplateValues {
                            arguments: &input.arguments,
                            project_path: &input.project_path,
                            context: &input
                                .context
                                .ok_or_else(|| CaseError::unhandled(function))?,
                        },
                    )
                }
                "expandScheduledSnippetTemplate" => {
                    let (template, input) = input()?;
                    expand_scheduled_snippet_template(
                        template,
                        &input.arguments,
                        &input.project_path,
                    )
                }
                "new SnippetExpansionError" => return Ok(expansion_error(SnippetExpansionError)),
                "new ScheduledSnippetBoundaryError" => {
                    return Ok(boundary_error(ScheduledSnippetBoundaryError));
                }
                _ => return Err(CaseError::unhandled(function)),
            };
            Ok(match result {
                Ok(value) => json!(value),
                Err(SnippetTemplateError::ExpansionTooLong(error)) => expansion_error(error),
                Err(SnippetTemplateError::Boundary(error)) => boundary_error(error),
                Err(SnippetTemplateError::Template(error)) => {
                    json!({"$":"error", "name":"TypeError", "message":error.to_string(), "properties":{}})
                }
            })
        },
    );
}
