use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::chat_search::compile_chat_search_query;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::query_frames::search_frames;

use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedSearch {
    text: String,
    order: TranscriptSearchOrder,
    mode: ChatSearchResultMode,
    offset: u64,
    limit: u64,
    snippet_limit: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedRows {
    frame_index: u64,
    rows: Vec<HistoricalSearchMessageRow>,
    advance_to: u64,
}

fn read<T: serde::de::DeserializeOwned>(
    function: &str,
    value: Option<&Value>,
) -> Result<T, CaseError> {
    // JavaScript JSON writes negative zero as zero before it enters an integer field.
    let input = garcon_js::json::Opaque::from_value(unknown(function, value)?.into_owned());
    let wire = serde_json::to_string(&input).unwrap();
    garcon_js::json::from_str(&wire)
        .map_err(|error| CaseError::new("InputError", error.to_string()))
}

fn read_search(function: &str, input: Option<&Value>) -> Result<ReaderSearch, CaseError> {
    let value: RecordedSearch = read(function, input)?;
    Ok(ReaderSearch {
        query: compile_chat_search_query(&value.text, None),
        order: value.order,
        mode: value.mode,
        offset: value.offset,
        limit: value.limit,
        snippet_limit: value.snippet_limit as usize,
    })
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "buildReaderFrames" => {
            let frames = search_frames(
                read_search(function, args.first())?,
                read(function, args.get(1))?,
            )
            .map_err(|error| CaseError::new("Error", error.code))?;
            let wire = serde_json::to_string(&frames).unwrap();
            Ok(garcon_js::json::from_str(&wire).unwrap())
        }
        "validateReaderStart" => Ok(json!(valid_reader_request(&ReaderRequest::Search(
            ReaderFrame::SearchStart(read_search(function, args.first())?)
        )))),
        "validateReaderChunk" => Ok(json!(valid_reader_request(&ReaderRequest::Search(
            ReaderFrame::SearchAllowlistChunk {
                chunk_index: 0,
                allowed_chats: read(function, args.first())?,
                done: true,
            }
        )))),
        "validateIndexerRows" => {
            let RecordedRows {
                frame_index,
                rows,
                advance_to,
            } = read(function, args.first())?;
            Ok(json!(valid_indexer_request(&IndexerRequest::SyncRows {
                frame_index,
                rows,
                advance_to
            })))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn typed_worker_frames_match_bun() {
    let cases = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/search-worker-frames"
        ),
        dispatch,
    );
    assert_eq!(cases.total, 254);
    assert_eq!(cases.total, cases.passed);
    assert_eq!(cases.with_wildcards, 0);
}

#[test]
fn frame_split_preserves_every_entry_in_order() {
    let input: Vec<_> = (1..=2_001)
        .rev()
        .map(|id| TranscriptSearchAllowedChat {
            chat_id: format!("{id:016}"),
            transcript_view_id: "view".into(),
            through_ordinal: id,
        })
        .collect();
    let frames = search_frames(
        ReaderSearch {
            query: compile_chat_search_query("synthetic", None),
            order: TranscriptSearchOrder::Allowlist,
            mode: ChatSearchResultMode::Page,
            offset: 0,
            limit: 20,
            snippet_limit: 1,
        },
        input.clone(),
    )
    .unwrap();
    assert_eq!(frames.len(), 3);
    assert_eq!(
        frames[1],
        ReaderFrame::SearchAllowlistChunk {
            chunk_index: 0,
            allowed_chats: input[..2_000].to_vec(),
            done: false
        }
    );
    assert_eq!(
        frames[2],
        ReaderFrame::SearchAllowlistChunk {
            chunk_index: 1,
            allowed_chats: input[2_000..].to_vec(),
            done: true
        }
    );
}
