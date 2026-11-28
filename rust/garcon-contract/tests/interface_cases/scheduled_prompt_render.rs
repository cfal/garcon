use garcon_cases::{CaseError, unknown};
use garcon_contract::scheduled_prompt_render::*;

use crate::helpers::{plain, recorded_cases};

#[test]
fn scheduled_prompt_render_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/scheduled-prompt-render"
        ),
        "common/scheduled-prompt-render.ts",
        |function, args| {
            let input = unknown(function, args.first())?;
            match function {
                "parseRenderScheduledPromptRequest" => {
                    Ok(plain(parse_render_scheduled_prompt_request(&input)))
                }
                "parseRenderScheduledPromptResponse" => {
                    Ok(plain(parse_render_scheduled_prompt_response(&input)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
