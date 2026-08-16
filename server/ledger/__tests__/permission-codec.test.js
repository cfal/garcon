import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { TranscriptLedgerStore } from '../store.ts';

const AT = '2026-08-16T00:00:00.000Z';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';

describe('permission ledger codec', () => {
  it('[TLV5-PERM.03-STORE-REOPEN-01] maps one public occurrence UUID to the schema-v1 durable incarnation key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-codec-'));
    const databasePath = path.join(root, 'chat-1', 'ledger.sqlite');
    try {
      const store = new TranscriptLedgerStore(root, {
        createViewId: () => 'view-1',
        now: () => AT,
      });
      const view = store.initializeCurrentView('chat-1', { contentStartOrdinal: 1 });
      store.append('chat-1', view.viewId, [{
        kind: 'permission-requested',
        at: AT,
        providerMeta: null,
        lifecycle: {
          kind: 'requested',
          permissionOccurrenceId: OCCURRENCE_ID,
          requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
          options: [],
        },
      }]);
      store.close();

      const database = new Database(databasePath);
      const stored = database.query(`
        SELECT payload_json FROM transcript_rows
        WHERE view_id = ? AND ordinal = 1
      `).get(view.viewId);
      const payload = JSON.parse(stored.payload_json);
      expect(payload.value).toMatchObject({
        kind: 'requested',
        incarnation: OCCURRENCE_ID,
      });
      expect(payload.value).not.toHaveProperty('permissionOccurrenceId');
      expect(payload.value).not.toHaveProperty('requestId');

      payload.value.requestId = 'provider-native-old-id';
      database.query(`
        UPDATE transcript_rows SET payload_json = ?
        WHERE view_id = ? AND ordinal = 1
      `).run(JSON.stringify(payload), view.viewId);
      database.close();

      const reopened = new TranscriptLedgerStore(root);
      try {
        const row = reopened.currentRows('chat-1')[0];
        expect(row).toMatchObject({
          kind: 'permission-requested',
          lifecycle: {
            kind: 'requested',
            permissionOccurrenceId: OCCURRENCE_ID,
          },
        });
        expect(row.lifecycle).not.toHaveProperty('requestId');
        expect(row.lifecycle).not.toHaveProperty('incarnation');
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
