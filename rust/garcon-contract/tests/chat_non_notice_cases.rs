use garcon_cases::{CaseError, markers, replay, round_tripped, text, unknown};
use serde::Serialize;
use serde_json::{Value, json};

use garcon_contract::{
    async_user_questions, chat_list, chat_transient_feed, chat_types, user_message_presentation,
};

fn json_value(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn run(suite: &str, dispatch: impl Fn(&str, &[Value]) -> Result<Value, CaseError>) {
    let cases = format!("{}/tests/cases/common/{suite}", env!("CARGO_MANIFEST_DIR"));
    let stats = replay(cases, dispatch);
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn chat_list_cases_match() {
    run("chat-list", |function, args| match function {
        "parseChatListResponse" => {
            let value = unknown(function, args.first())?;
            chat_list::parse_chat_list_response(&value)
                .map(json_value)
                .map_err(|error| CaseError::new(error.name(), error.to_string()))
        }
        "new ChatListContractError" => {
            let field =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            let error = chat_list::ChatListContractError::new(field);
            Ok(
                json!({"$": "error", "name": error.name(), "message": error.to_string(), "properties": {}}),
            )
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn user_message_presentation_cases_match() {
    run(
        "user-message-presentation",
        |function, args| match function {
            "parseUserMessagePresentation" => {
                let value = round_tripped(function, args.first())?;
                user_message_presentation::parse_user_message_presentation(value.as_deref())
                    .map(|value| value.map_or_else(markers::undefined, json_value))
                    .map_err(|error| CaseError::new(error.name(), error.to_string()))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn chat_messages_cases_match() {
    run("chat-messages", |function, args| {
        let value = unknown(function, args.first())?;
        let error = |error: async_user_questions::InvalidAsyncQuestionReply| {
            CaseError::new("TypeError", error.to_string())
        };
        let text = match function {
            "parseChatMessageJson" => serde_json::to_string(
                &chat_types::parse_non_notice_chat_message(&value).map_err(error)?,
            ),
            "parseChatMessagesJson" => serde_json::to_string(
                &chat_types::parse_non_notice_chat_messages(&value).map_err(error)?,
            ),
            _ => return Err(CaseError::unhandled(function)),
        }
        .unwrap();
        Ok(json!(text))
    });
}

#[test]
fn chat_transient_feed_cases_match() {
    use chat_transient_feed::*;
    fn attach_class_names(row: &mut Value) {
        let mut fields = row["message"].take().as_object().unwrap().clone();
        let tool = fields.get_mut("requestedTool").unwrap();
        let tool_fields = tool.take().as_object().unwrap().clone();
        // The recorded permission rows all carry this concrete tool class.
        assert_eq!(tool_fields["type"], "bash-tool-use");
        *tool = markers::instance("BashToolUseMessage", tool_fields);
        row["message"] = markers::instance("PermissionRequestMessage", fields);
    }

    run("chat-transient-feed", |function, args| {
        let value = unknown(function, args.first())?;
        let error = |error: async_user_questions::InvalidAsyncQuestionReply| {
            CaseError::new("TypeError", error.to_string())
        };
        match function {
            "parseTransientFeedRow" => {
                let mut parsed = json_value(parse_transient_feed_row(&value).map_err(error)?);
                if !parsed.is_null() {
                    attach_class_names(&mut parsed);
                }
                Ok(parsed)
            }
            "parseChatTransientFeedSnapshot" => {
                let mut parsed =
                    json_value(parse_chat_transient_feed_snapshot(&value).map_err(error)?);
                if let Some(rows) = parsed.get_mut("rows").and_then(Value::as_array_mut) {
                    for row in rows {
                        attach_class_names(row);
                    }
                }
                Ok(parsed)
            }
            "parseChatTransientFeedMutation" => {
                let mut parsed =
                    json_value(parse_chat_transient_feed_mutation(&value).map_err(error)?);
                if let Some(row) = parsed
                    .get_mut("mutation")
                    .and_then(|mutation| mutation.get_mut("row"))
                {
                    attach_class_names(row);
                }
                Ok(parsed)
            }
            "parseChatTransientControlAction" => {
                Ok(json_value(parse_chat_transient_control_action(&value)))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}
