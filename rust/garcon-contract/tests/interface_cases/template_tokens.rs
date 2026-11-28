use std::process::Command;

use garcon_cases::{CaseError, javascript_number, markers, text, unknown};
use garcon_contract::template_tokens::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{bun::bun_fixtures, helpers::recorded_cases};

fn out_of_space(error: TemplateExpansionTooLongError) -> Value {
    json!({"$":"error", "name":"TemplateExpansionTooLongError", "message":error.to_string(), "properties":{"maxLength":markers::number(error.max_length)}})
}

#[test]
fn template_tokens_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/template-tokens"
        ),
        "common/template-tokens.ts",
        |function, args| match function {
            "expandTemplate" => {
                let template =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                let allowed = unknown(function, args.get(1))?;
                let allowed = allowed
                    .as_array()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let allowed: Vec<&str> = allowed
                    .iter()
                    .map(Value::as_str)
                    .collect::<Option<_>>()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let values = unknown(function, args.get(2))?;
                let max_length = javascript_number(function, args.get(3))?;
                Ok(
                    match expand_template(
                        template,
                        &allowed,
                        |variable| values[variable].as_str(),
                        max_length,
                    ) {
                        Ok(value) => json!(value),
                        Err(TemplateExpansionError::TooLong(error)) => out_of_space(error),
                        Err(error @ TemplateExpansionError::MissingValue) => {
                            json!({"$":"error", "name":"TypeError", "message":error.to_string(), "properties":{}})
                        }
                    },
                )
            }
            "new TemplateExpansionTooLongError" => {
                Ok(out_of_space(TemplateExpansionTooLongError {
                    max_length: javascript_number(function, args.first())?,
                }))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[derive(Deserialize)]
struct Fixtures {
    runtime: Vec<RuntimeFixture>,
    tokens: Vec<TokenFixture>,
    validation: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFixture {
    chat_id: String,
    at: i64,
    result: RuntimeTemplateValues,
}

#[derive(Deserialize)]
struct TokenFixture {
    template: String,
    allowed: Vec<String>,
    result: Value,
}

#[test]
fn runtime_dates_and_token_iterator_match_bun() {
    const CHILD: &str = "GARCON_TEMPLATE_TOKENS_ORACLE";
    if std::env::var_os(CHILD).is_none() {
        for zone in ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "template_tokens::runtime_dates_and_token_iterator_match_bun",
                ])
                .env(CHILD, "1")
                .env("TZ", zone)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "TZ={zone}:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    }

    let fixtures: Fixtures =
        garcon_js::json::from_str(&bun_fixtures("template-token-fixtures.ts")).unwrap();
    assert_eq!(fixtures.runtime.len(), 4);
    for fixture in fixtures.runtime {
        assert_eq!(
            runtime_template_values(&fixture.chat_id, fixture.at).unwrap(),
            fixture.result
        );
    }
    assert_eq!(fixtures.tokens.len(), 4);
    for fixture in fixtures.tokens {
        let allowed: Vec<_> = fixture.allowed.iter().map(String::as_str).collect();
        let actual: Vec<_> = match_template_tokens(&fixture.template, &allowed).collect();
        assert_eq!(json!(actual), fixture.result, "{}", fixture.template);
    }
    assert_eq!(json!(TEMPLATE_VALIDATION_VALUES), fixtures.validation);
}
