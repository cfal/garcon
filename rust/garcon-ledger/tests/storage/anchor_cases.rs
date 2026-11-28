use garcon_base::errors::{DiagnosticError, error_metadata};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    chat_types::{AssistantMessage, ChatMessage},
    transcript_anchor_page::TranscriptAnchorDirection,
};
use garcon_js::json::from_slice;
use garcon_ledger::{
    anchor_page::{AnchorScanInput, AnchorScanProgress, read_anchor_batch, read_anchor_page},
    connection_setup::create_schema,
    contracts::{LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome, transcript_view_id},
    errors::{LedgerCodecError, LedgerError},
    sqlite_operations::bind_ordinal,
    staging_views::{encode_drafts, insert_encoded_rows},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::bulk_views::notice;

const AT: &str = "2026-11-28T09:00:00.000Z";
const VIEW: &str = "anchor-view";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    layout: String,
    direction: TranscriptAnchorDirection,
    anchors_remaining: u64,
    cursor_ordinal: Option<u64>,
    watermark_ordinal: Option<u64>,
    gap_ordinal: Option<u64>,
    pause_after: Option<u64>,
}

fn draft(index: usize, letter: char) -> LedgerRowDraft {
    let data = match letter {
        'a' => LedgerRowData::ProviderRow {
            message: ChatMessage::Assistant(AssistantMessage {
                timestamp: AT.into(),
                content: format!("anchor {index}"),
                questions: None,
            }),
        },
        'h' => LedgerRowData::RunEnded {
            origin: RunOrigin::Core,
            outcome: RunOutcome::Finished,
            error: None,
        },
        _ => return notice(&format!("notice {index}")),
    };
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data,
    }
}

fn error_case(error: Box<dyn std::error::Error>) -> CaseError {
    let error = error.as_ref();
    let name = if let Some(error) = error.downcast_ref::<LedgerError>() {
        error.diagnostic_metadata().name
    } else if let Some(error) = error.downcast_ref::<LedgerCodecError>() {
        error.diagnostic_metadata().name
    } else {
        error_metadata(error).name
    };
    CaseError::new(name, error.to_string())
}

fn serialize(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let fixture: Fixture = serde_json::from_value(unknown(function, args.first())?.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    let db = Connection::open_in_memory().unwrap();
    create_schema(&db).unwrap();
    db.execute(
        "INSERT INTO transcript_views VALUES (?, ?, ?, ?)",
        params![VIEW, "current", AT, 1],
    )
    .unwrap();
    let view = transcript_view_id(VIEW).unwrap();
    let drafts: Vec<_> = fixture
        .layout
        .chars()
        .enumerate()
        .map(|(index, letter)| draft(index, letter))
        .collect();
    insert_encoded_rows(&db, &view, &encode_drafts(&drafts).unwrap(), 1).unwrap();
    if let Some(gap) = fixture.gap_ordinal {
        db.execute(
            "DELETE FROM transcript_rows WHERE view_id = ? AND ordinal = ?",
            params![VIEW, bind_ordinal(gap)],
        )
        .unwrap();
    }
    let watermark_ordinal = fixture.watermark_ordinal.unwrap_or(drafts.len() as u64);
    let input = AnchorScanInput {
        direction: fixture.direction,
        cursor_ordinal: fixture.cursor_ordinal.unwrap_or(match fixture.direction {
            TranscriptAnchorDirection::Backward => watermark_ordinal + 1,
            TranscriptAnchorDirection::Forward => 0,
        }),
        watermark_ordinal,
        anchors_remaining: fixture.anchors_remaining,
    };
    match function {
        "anchorBatchFixture" => {
            let mut checked = 0;
            let batch = read_anchor_batch(
                &db,
                &view,
                &input,
                AnchorScanProgress {
                    cursor_ordinal: input.cursor_ordinal,
                    anchors_remaining: input.anchors_remaining,
                },
                || {
                    checked += 1;
                    fixture.pause_after.is_some_and(|after| checked >= after)
                },
            )
            .map_err(error_case)?;
            serialize(batch)
        }
        "anchorPageFixture" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            let page = runtime
                .block_on(read_anchor_page(
                    &input,
                    |progress, due| read_anchor_batch(&db, &view, &input, progress, due),
                    || Ok(()),
                ))
                .map_err(error_case)?;
            serialize(page)
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn anchor_batch_and_page_cases_replay_against_bun() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/anchor"),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
}
