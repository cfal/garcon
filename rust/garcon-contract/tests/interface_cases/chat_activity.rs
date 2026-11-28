use garcon_cases::{CaseError, unknown};
use garcon_contract::chat_activity::is_chat_activity_status;
use serde_json::json;

use crate::helpers::recorded_cases;

#[test]
fn chat_activity_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-activity"
        ),
        "common/chat-activity.ts",
        |function, args| match function {
            "isChatActivityStatus" => Ok(json!(
                is_chat_activity_status(unknown(function, args.first())?.as_ref()).is_some()
            )),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
