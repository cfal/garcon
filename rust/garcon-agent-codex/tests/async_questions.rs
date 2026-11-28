use garcon_agent_codex::async_questions::{
    codex_async_questions, codex_historical_question_reply, codex_historical_user_message,
    codex_question_reply_input,
};
use garcon_cases::{CaseError, markers, replay, text, unknown};
use garcon_contract::{async_user_questions::AsyncQuestionReply, chat_types::UserMessage};
use serde_json::{Value, json};

fn user_message(message: UserMessage) -> Value {
    let Value::Object(fields) = json!(message) else {
        panic!("user message did not serialize as an object");
    };
    markers::instance("UserMessage", fields)
}

#[test]
fn recorded_async_questions_and_native_reply_envelopes_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/async-questions"),
        |function, args| {
            let first = text(function, args.first())?.unwrap();
            Ok(match function {
                "codexAsyncQuestions" => {
                    let delivery = unknown(function, args.get(1))?;
                    let questions = unknown(function, args.get(2))?;
                    codex_async_questions(first, &delivery, &questions)
                        .map_or_else(markers::undefined, |questions| json!(questions))
                }
                "codexQuestionReplyInput" => {
                    let reply: Option<AsyncQuestionReply> =
                        serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                            .expect("valid native question reply");
                    match codex_question_reply_input(first, reply.as_ref()) {
                        Ok(content) => json!(content),
                        Err(error) => json!({
                            "$":"error","name":"Error","message":error.to_string(),"properties":{}
                        }),
                    }
                }
                "codexHistoricalQuestionReply" => {
                    let content = text(function, args.get(1))?.unwrap();
                    let upstream_id = text(function, args.get(2))?;
                    codex_historical_question_reply(first, content, upstream_id)
                        .map_or(Value::Null, user_message)
                }
                "codexHistoricalUserMessage" => {
                    let content = text(function, args.get(1))?.unwrap();
                    let upstream_id = text(function, args.get(2))?;
                    user_message(codex_historical_user_message(first, content, upstream_id))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
