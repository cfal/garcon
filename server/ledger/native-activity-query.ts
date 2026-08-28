import type { Database } from 'bun:sqlite';
import type { TranscriptViewId } from './contracts.js';

export interface ProviderActivityWatermark {
  readonly ordinal: number;
  readonly at: string;
}

export function readProviderActivityWatermark(
  database: Database,
  viewId: TranscriptViewId,
  contentStartOrdinal: number,
): ProviderActivityWatermark | null {
  return database.query<ProviderActivityWatermark, [string, number]>(`
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
        AND json_extract(payload_json, '$.value.detail.type') IN (
          'chat-id-request',
          'chat-id-discovery-disabled'
        )
      )
    )
    ORDER BY ordinal DESC LIMIT 1
  `).get(viewId, contentStartOrdinal) ?? null;
}
