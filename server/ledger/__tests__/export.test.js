import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../../common/chat-types.ts';
import {
  exportRawSupportTranscript,
  exportUserTranscript,
} from '../export.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('transcript export boundaries', () => {
  it('removes provider-private metadata and native sessions from user exports', async () => {
    await withLedger((ledger) => {
      ledger.initializeChat('chat-1', [
        {
          kind: 'session',
          at: TS,
          detail: {
            agentSessionId: 'native-1',
            nativeSession: {
              ownerId: 'test',
              schemaVersion: 1,
              value: { path: '/private/native-history.jsonl' },
            },
            nativeSeedReceipt: null,
          },
          providerMeta: null,
        },
        {
          kind: 'provider-row',
          at: TS,
          message: new AssistantMessage(TS, 'visible answer'),
          providerMeta: { privateItemId: 'provider-secret' },
        },
      ]);

      const exported = exportUserTranscript(ledger, 'chat-1');
      const serialized = JSON.stringify(exported);

      expect(exported.rows.map((row) => row.kind)).toEqual(['provider-row']);
      expect(serialized).not.toContain('providerMeta');
      expect(serialized).not.toContain('provider-secret');
      expect(serialized).not.toContain('/private/native-history.jsonl');
    });
  });

  it('keeps full rows only through the explicit support export', async () => {
    await withLedger((ledger) => {
      ledger.initializeChat('chat-1', [{
        kind: 'provider-row',
        at: TS,
        message: new AssistantMessage(TS, 'visible answer'),
        providerMeta: { privateItemId: 'provider-secret' },
      }]);

      const exported = exportRawSupportTranscript(ledger, 'chat-1');

      expect(exported.rows[0]?.providerMeta).toEqual({ privateItemId: 'provider-secret' });
    });
  });
});

async function withLedger(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-export-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(root));
  try {
    await run(ledger);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
