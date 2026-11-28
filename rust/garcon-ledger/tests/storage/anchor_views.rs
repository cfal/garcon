use garcon_contract::transcript_anchor_page::{
    TranscriptAnchorDirection, TranscriptAnchorPageStatus,
};
use garcon_ledger::{anchor_page::AnchorScanInput, contracts::transcript_view_id};

use super::bulk_views::{initialize, notice, store};

#[tokio::test(start_paused = true)]
async fn an_anchor_page_covers_all_transparent_rows_across_raw_batches() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    initialize(&store, "ledger", "current", &vec![notice("synthetic"); 401]);
    let result = store
        .anchor_page(
            "ledger",
            &transcript_view_id("current").unwrap(),
            AnchorScanInput {
                direction: TranscriptAnchorDirection::Backward,
                cursor_ordinal: 402,
                watermark_ordinal: 401,
                anchors_remaining: 1,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.page_status, TranscriptAnchorPageStatus::Exhausted);
    assert_eq!(result.anchors_remaining, 1);
    assert_eq!((result.start_ordinal, result.end_ordinal), (1, 402));
    assert!(result.rows.iter().map(|row| row.ordinal).eq(1..=401));
}

#[tokio::test]
async fn anchor_pages_include_oversized_rows_and_the_rest_of_the_interval() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let view = transcript_view_id("large-payload").unwrap();
    let mut rows = vec![notice("synthetic"); 205];
    let oversized = "x".repeat(1024 * 1024 + 1);
    rows[0] = notice(&oversized);
    rows[204] = notice(&oversized);
    initialize(&store, "ledger", view.as_str(), &rows);
    let page = store
        .anchor_page(
            "ledger",
            &view,
            AnchorScanInput {
                direction: TranscriptAnchorDirection::Backward,
                cursor_ordinal: 206,
                watermark_ordinal: 205,
                anchors_remaining: 1,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!((page.start_ordinal, page.end_ordinal), (1, 206));
    assert_eq!(page.page_status, TranscriptAnchorPageStatus::Exhausted);
    assert!(page.rows.iter().map(|row| row.ordinal).eq(1..=205));
    for index in [0, 204] {
        assert!(
            matches!(&page.rows[index].data, garcon_ledger::contracts::LedgerRowData::Notice { message, .. }
            if message == &oversized)
        );
    }
}
