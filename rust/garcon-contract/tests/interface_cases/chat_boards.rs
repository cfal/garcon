use garcon_cases::{CaseError, markers, unknown};
use garcon_contract::chat_boards::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::helpers::{plain, recorded_cases};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transition {
    current_tags: Vec<String>,
    source_tags: Vec<String>,
    applied_target_tags: Vec<String>,
}

fn decode<T: DeserializeOwned>(function: &str, value: Value) -> Result<T, CaseError> {
    serde_json::from_value(value).map_err(|_| CaseError::unhandled(function))
}

#[test]
fn chat_boards_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-boards"
        ),
        "common/chat-boards.ts",
        |function, args| {
            let value = || unknown(function, args.first());
            match function {
                "isChatBoardId" => Ok(json!(is_chat_board_id(value()?.as_ref()))),
                "isChatBoardColumnId" => Ok(json!(is_chat_board_column_id(value()?.as_ref()))),
                "normalizeChatBoardColumn" => {
                    Ok(plain(normalize_chat_board_column(value()?.as_ref())))
                }
                "normalizeChatBoard" => Ok(plain(normalize_chat_board(value()?.as_ref()))),
                "normalizeChatBoardCatalog" => {
                    Ok(plain(normalize_chat_board_catalog(value()?.as_ref())))
                }
                "normalizeChatBoardMutationResponse" => Ok(plain(
                    normalize_chat_board_mutation_response(value()?.as_ref()),
                )),
                "normalizeCreateChatBoardResponse" => Ok(plain(
                    normalize_create_chat_board_response(value()?.as_ref()),
                )),
                "normalizeBoardTagInput" => Ok(plain(normalize_board_tag_input(value()?.as_ref()))),
                "chatMatchesBoardColumn" => {
                    let tags: Vec<String> = decode(function, value()?.into_owned())?;
                    let rule: ChatBoardColumnRule =
                        decode(function, unknown(function, args.get(1))?.into_owned())?;
                    Ok(json!(chat_matches_board_column(&tags, &rule)))
                }
                "tagSetMatchesBoardColumn" => {
                    let set = args
                        .first()
                        .filter(|value| markers::kind(value) == Some("set"))
                        .and_then(|value| value["value"].as_array())
                        .ok_or_else(|| CaseError::unhandled(function))?;
                    let tags = set
                        .iter()
                        .map(Value::as_str)
                        .collect::<Option<_>>()
                        .ok_or_else(|| CaseError::unhandled(function))?;
                    let rule: ChatBoardColumnRule =
                        decode(function, unknown(function, args.get(1))?.into_owned())?;
                    Ok(json!(tag_set_matches_board_column(&tags, &rule)))
                }
                "calculateChatTagTransition" => {
                    let input: Transition = decode(function, value()?.into_owned())?;
                    Ok(json!(calculate_chat_tag_transition(
                        &input.current_tags,
                        &input.source_tags,
                        &input.applied_target_tags
                    )))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
