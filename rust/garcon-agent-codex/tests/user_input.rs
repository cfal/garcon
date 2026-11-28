use garcon_agent_codex::user_input::{
    CodexUserInputError, codex_historical_question_result, codex_historical_user_input,
    codex_user_input_message, codex_user_input_response,
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, markers, replay_with_options, text, unknown,
};
use garcon_contract::chat_types::{
    AskUserQuestionPrompt, ToolUseChatMessage, parse_tool_use_message,
};
use serde_json::{Value, json};

fn type_error(error: CodexUserInputError) -> Value {
    json!({"$":"error","name":"TypeError","message":error.to_string(),"properties":{}})
}

fn tool_value(tool: ToolUseChatMessage) -> Value {
    let Value::Object(fields) = json!(tool) else {
        panic!("tool failed to serialize as object");
    };
    markers::instance("AskUserQuestionToolUseMessage", fields)
}

#[test]
fn synchronous_questions_and_historical_answers_match_recorded_cases() {
    let stats = replay_with_options(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/user-input"),
        ReplayOptions {
            result_order_exceptions: &[
                ResultOrderException {
                    function: "codexUserInputMessage",
                    path: "$.result.fields.questions[*]",
                    reason: "Codex creates its options last; the shared parser writes them before header",
                },
                ResultOrderException {
                    function: "codexHistoricalUserInput",
                    path: "$.result.fields.questions[*]",
                    reason: "Codex creates its options last; the shared parser writes them before header",
                },
            ],
            ..Default::default()
        },
        |function, args| {
            Ok(match function {
                "codexUserInputMessage" => {
                    let timestamp = text(function, args.first())?.unwrap();
                    let item = unknown(function, args.get(1))?;
                    let questions = unknown(function, args.get(2))?;
                    codex_user_input_message(timestamp, &item, &questions)
                        .map_or_else(type_error, tool_value)
                }
                "codexHistoricalUserInput" => {
                    let timestamp = text(function, args.first())?.unwrap();
                    let call_id = text(function, args.get(1))?.unwrap();
                    let input = unknown(function, args.get(2))?;
                    tool_value(codex_historical_user_input(timestamp, call_id, &input))
                }
                "codexHistoricalQuestionResult" => {
                    let output = unknown(function, args.first())?;
                    let questions: Vec<AskUserQuestionPrompt> =
                        serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                            .unwrap();
                    json!(codex_historical_question_result(&output, &questions))
                }
                "codexUserInputResponse" => {
                    let value = unknown(function, args.first())?;
                    let tool = parse_tool_use_message(&value).unwrap();
                    let decision =
                        serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                            .unwrap();
                    codex_user_input_response(&tool, &decision)
                        .map_or_else(type_error, |value| json!(value))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
    assert_eq!(stats.known_differences, 1);
}
