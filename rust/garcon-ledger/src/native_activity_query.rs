use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    contracts::{NativeActivityProviderWatermark, TranscriptViewId},
    sqlite_operations::{LedgerResult, bind_ordinal, non_negative_integer, run_query},
};

pub fn read_provider_activity_watermark(
    db: &Connection,
    view_id: &TranscriptViewId,
    content_start_ordinal: u64,
) -> LedgerResult<Option<NativeActivityProviderWatermark>> {
    run_query(|| {
        db.prepare_cached(
            "
    SELECT ordinal, at
    FROM transcript_rows
    WHERE view_id = ? AND ordinal >= ? AND (
      kind IN (
        'provider-row',
        'session',
        'permission-requested',
        'permission-cancelled',
        'permission-expired'
      )
      OR (
        kind = 'run-ended'
        AND json_extract(payload_json, '$.value.origin') = 'provider'
      )
      OR (
        kind = 'user-input'
        AND client_message_id IS NULL
      )
      OR (
        kind = 'notice'
        AND (
          json_extract(payload_json, '$.value.detail.type') IN (
            'chat-id-request',
            'chat-id-disclosure',
            'inter-agent-send-request',
            'agent-start-request',
            'agent-resume-request',
            'agent-stop-request',
            'agent-schedule-request',
            'ticket-command-request',
            'garcon-command-rejection-input',
            'inter-agent-message-received'
          )
          OR (
            json_extract(payload_json, '$.value.detail.type') IN ('agent-start-outcome', 'agent-resume-outcome', 'agent-schedule-outcome', 'ticket-command-outcome')
            AND json_type(payload_json, '$.value.detail.nativeResultInput') = 'true'
          )
          OR (
            json_extract(payload_json, '$.value.detail.type') = 'chat-id-discovery-failure'
            AND json_extract(payload_json, '$.value.detail.reason') = 'disabled'
          )
        )
      )
    )
    ORDER BY ordinal DESC LIMIT 1
  ",
        )?
        .query_row(
            params![view_id.as_str(), bind_ordinal(content_start_ordinal)],
            |row| Ok(NativeActivityProviderWatermark {
                ordinal: non_negative_integer(row.get(0)?, 0)?,
                at: row.get(1)?,
            }),
        )
        .optional()
    })
}
