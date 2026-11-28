use garcon_cases::{CaseError, unknown};
use garcon_contract::command_output::{
    command_outcome_text, is_clean_command_success, is_command_output_data, parse_command_outcome,
    parse_command_output_context, parse_command_working_directory,
};
use serde_json::json;

use crate::helpers::{plain, recorded_cases, typed};

#[test]
fn command_output_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/command-output"
        ),
        "common/command-output.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            match function {
                "isCommandOutputData" => Ok(json!(is_command_output_data(&value))),
                "parseCommandOutputContext" => Ok(plain(parse_command_output_context(&value))),
                "parseCommandWorkingDirectory" => {
                    Ok(plain(parse_command_working_directory(&value)))
                }
                "parseCommandOutcome" => Ok(plain(parse_command_outcome(&value))),
                "isCleanCommandSuccess" => Ok(json!(is_clean_command_success(&typed(
                    function,
                    args,
                    parse_command_outcome
                )?))),
                "commandOutcomeText" => Ok(json!(command_outcome_text(&typed(
                    function,
                    args,
                    parse_command_outcome
                )?))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
