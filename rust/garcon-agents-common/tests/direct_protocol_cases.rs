use garcon_agents_common::direct::{
    anthropic_compatible_chat_runtime::{
        anthropic_messages_url, build_anthropic_compatible_user_content,
    },
    openai_compatible_chat_runtime::build_open_ai_compatible_user_content,
    openai_compatible_responses_protocol::{
        ResponsesRequestError, ResponsesStreamState, consume_responses_stream_event,
        extract_responses_output_text, is_unresolved_checkpoint,
    },
    openai_compatible_responses_runtime::{
        build_open_ai_responses_user_content, extract_open_ai_responses_text_content,
    },
};
use garcon_cases::{CaseError, replay, round_tripped, unknown};
use garcon_contract::agent_execution::AgentAttachment;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn arg<T: DeserializeOwned>(function: &str, value: Option<&Value>) -> Result<T, CaseError> {
    serde_json::from_value(
        round_tripped(function, value)?
            .ok_or_else(|| CaseError::undeliverable("missing typed argument"))?
            .into_owned(),
    )
    .map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[test]
fn recorded_direct_protocols_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/direct-protocols"),
        |function, args| {
            let first = args.first();
            match function {
                "messagesUrl" => Ok(json!(anthropic_messages_url(&arg::<String>(
                    function, first
                )?))),
                "chatContent" | "messagesContent" | "responsesContent" => {
                    let text: String = arg(function, first)?;
                    let attachments: Vec<AgentAttachment> = arg(function, args.get(1))?;
                    Ok(match function {
                        "chatContent" => {
                            json!(build_open_ai_compatible_user_content(&text, &attachments))
                        }
                        "messagesContent" => {
                            json!(build_anthropic_compatible_user_content(&text, &attachments))
                        }
                        _ => {
                            let content = build_open_ai_responses_user_content(&text, &attachments);
                            json!({"content": content, "text": extract_open_ai_responses_text_content(&content)})
                        }
                    })
                }
                "responsesOutput" => Ok(json!(extract_responses_output_text(
                    unknown(function, first)?.as_ref()
                ))),
                "responsesStream" => {
                    let mut state = ResponsesStreamState::default();
                    for event in arg::<Vec<Value>>(function, first)? {
                        consume_responses_stream_event(&mut state, &event);
                    }
                    Ok(json!(state))
                }
                "unresolvedCheckpoint" => {
                    Ok(json!(is_unresolved_checkpoint(&ResponsesRequestError {
                        message: "synthetic".into(),
                        response_code: arg(function, first)?,
                        output_accepted: arg(function, args.get(1))?,
                    })))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
