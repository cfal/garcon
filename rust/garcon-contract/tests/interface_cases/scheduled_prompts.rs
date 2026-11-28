use garcon_cases::{CaseError, markers, round_tripped, text, unknown};
use garcon_contract::{
    scheduled_prompts::*,
    template_tokens::{RuntimeTemplateValues, TemplateExpansionError},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    bun::bun_fixtures,
    helpers::{plain, recorded_cases},
};

fn template_error(error: TemplateExpansionError) -> CaseError {
    match error {
        TemplateExpansionError::TooLong(error) => {
            CaseError::new("TemplateExpansionTooLongError", error.to_string())
                .with_property("maxLength", markers::number(error.max_length))
        }
        TemplateExpansionError::MissingValue => CaseError::new("TypeError", error.to_string()),
    }
}

fn serialize<T: Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, |value| {
        let encoded = serde_json::to_string(&value).unwrap();
        garcon_js::json::from_str(&encoded).unwrap()
    })
}

#[test]
fn scheduled_prompts_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/scheduled-prompts"
        ),
        "common/scheduled-prompts.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            let first_text =
                || text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function));
            let template_values = || {
                RuntimeTemplateValues::<String>::deserialize(
                    unknown(function, args.get(1))?.as_ref(),
                )
                .map_err(|error| CaseError::undeliverable(error.to_string()))
            };
            match function {
                "hasLeadingSlashCommand" => Ok(json!(has_leading_slash_command(first_text()?))),
                "isMinuteAlignedIso" => Ok(json!(is_minute_aligned_iso(&value))),
                "isScheduledPromptIntervalMinutes" => {
                    Ok(json!(is_scheduled_prompt_interval_minutes(&value)))
                }
                "isScheduledPromptsInvalidationReason" => {
                    Ok(json!(is_scheduled_prompts_invalidation_reason(&value)))
                }
                "normalizeCreateScheduledPromptResponse" => Ok(serialize(
                    normalize_create_scheduled_prompt_response(&value),
                )),
                "normalizeScheduledChatTitle" => Ok(plain(normalize_scheduled_chat_title(&value))),
                "normalizeScheduledChatTitleTemplate" => {
                    Ok(plain(normalize_scheduled_chat_title_template(&value)))
                }
                "normalizeScheduledPrompt" => Ok(serialize(normalize_scheduled_prompt(&value))),
                "normalizeScheduledPromptDefinitionInput" => Ok(serialize(
                    normalize_scheduled_prompt_definition_input(&value),
                )),
                "normalizeScheduledPromptName" => {
                    let arg = round_tripped(function, args.first())?;
                    let name = normalize_scheduled_prompt_name(arg.as_deref());
                    Ok(if name.is_absent() {
                        markers::undefined()
                    } else {
                        json!(name)
                    })
                }
                "normalizeScheduledPromptRunLogEntry" => {
                    Ok(plain(normalize_scheduled_prompt_run_log_entry(&value)))
                }
                "normalizeScheduledPromptSchedule" => {
                    Ok(plain(normalize_scheduled_prompt_schedule(&value)))
                }
                "normalizeScheduledPromptsSnapshot" => {
                    Ok(serialize(normalize_scheduled_prompts_snapshot(&value)))
                }
                "normalizeScheduledPromptTarget" => {
                    Ok(serialize(normalize_scheduled_prompt_target(&value)))
                }
                "parseScheduledPromptExecutionSelection" => {
                    Ok(plain(parse_scheduled_prompt_execution_selection(&value)))
                }
                "renderScheduledChatTitle" => {
                    render_scheduled_chat_title(first_text()?, &template_values()?)
                        .map(|title| json!(title))
                        .map_err(|error| match error {
                            ScheduledChatTitleError::Expansion(error) => template_error(error),
                            ScheduledChatTitleError::InvalidTitle => {
                                CaseError::new("TypeError", error.to_string())
                            }
                        })
                }
                "renderScheduledPrompt" => {
                    render_scheduled_prompt(first_text()?, &template_values()?)
                        .map(|prompt| json!(prompt))
                        .map_err(template_error)
                }
                "scheduledPromptFitsRenderedLimit" => scheduled_prompt_fits_rendered_limit(
                    first_text()?,
                    text(function, args.get(1))?,
                )
                .map(|result| json!(result))
                .map_err(template_error),
                "scheduledPromptSelectionMatches" => {
                    let read = |value: &Value| {
                        ScheduledPromptExecutionSelection::deserialize(value)
                            .map_err(|error| CaseError::undeliverable(error.to_string()))
                    };
                    let expected = read(&value)?;
                    let current = read(unknown(function, args.get(1))?.as_ref())?;
                    Ok(json!(scheduled_prompt_selection_matches(
                        &expected, &current
                    )))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

#[test]
fn scheduled_settings_preserve_javascript_json_text() {
    #[derive(Deserialize)]
    struct Fixture {
        raw: String,
        expected: String,
    }
    let fixture: Fixture =
        garcon_js::json::from_str(&bun_fixtures("scheduled-prompts-fixtures.ts")).unwrap();
    let input = garcon_js::json::from_str(&fixture.raw).unwrap();
    let normalized = normalize_scheduled_prompt_target(&input).unwrap();
    let actual = serde_json::to_string(&normalized).unwrap();
    assert_eq!(actual, fixture.expected);
    assert!(actual.contains(r#""values":{"n":1,"big":9007199254740992,"exp21":1e+21,"zero":0}"#));
}
