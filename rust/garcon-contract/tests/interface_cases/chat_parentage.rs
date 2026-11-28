use garcon_cases::{CaseError, unknown};
use garcon_contract::chat_parentage::{chat_lineages_equal, parse_chat_lineage};
use serde_json::json;

use crate::helpers::{plain, recorded_cases};

#[test]
fn chat_parentage_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-parentage"
        ),
        "common/chat-parentage.ts",
        |function, args| match function {
            "parseChatLineage" => Ok(plain(parse_chat_lineage(
                unknown(function, args.first())?.as_ref(),
            ))),
            "chatLineagesEqual" => {
                let parse = |index: usize| {
                    let value = unknown(function, args.get(index))?;
                    if value.is_null() {
                        Ok(None)
                    } else {
                        parse_chat_lineage(&value)
                            .map(Some)
                            .ok_or_else(|| CaseError::unhandled(function))
                    }
                };
                Ok(json!(chat_lineages_equal(
                    parse(0)?.as_ref(),
                    parse(1)?.as_ref()
                )))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
