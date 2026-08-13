import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import {
  NATIVE_TRANSCRIPT_DRIFT_NOTICE,
  NativeTranscriptActivityService,
} from '../native-activity.ts';
import { ledgerRowsToMessages } from '../presentation.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const SESSION_AT = '2026-08-12T00:00:01.000Z';
const PROVIDER_AT = '2026-08-12T00:00:02.000Z';
const EXTERNAL_AT = '2026-08-12T00:00:03.000Z';

describe('NativeTranscriptActivityService', () => {
  it('warns from the integration watermark and deduplicates the observed native tail', async () => {
    await withFixture(async ({ ledger, activity, setNativeAt }) => {
      ledger.initializeChat('chat-1', baseRows());

      expect(await activity.check('chat-1')).toBe(true);
      expect(await activity.check('chat-1')).toBe(false);
      setNativeAt('2026-08-12T00:00:04.000Z');
      expect(await activity.check('chat-1')).toBe(true);

      const notices = ledger.currentRows('chat-1').filter((row) => row.kind === 'notice');
      expect(notices.map((row) => row.message)).toEqual([
        NATIVE_TRANSCRIPT_DRIFT_NOTICE,
        NATIVE_TRANSCRIPT_DRIFT_NOTICE,
      ]);
      expect(notices.map((row) => row.detail.observedNativeWatermark)).toEqual([
        EXTERNAL_AT,
        '2026-08-12T00:00:04.000Z',
      ]);
      expect(ledgerRowsToMessages(notices).map((message) => message.action)).toEqual([
        'reload-native-history',
        'reload-native-history',
      ]);
    });
  });

  it('does not let later core-authored rows hide missed native output', async () => {
    await withFixture(async ({ ledger, activity }) => {
      ledger.initializeChat('chat-1', [
        ...baseRows(),
        {
          kind: 'user-input',
          at: '2026-08-12T00:00:10.000Z',
          detail: {
            clientMessageId: 'message-1',
            message: new UserMessage('2026-08-12T00:00:10.000Z', 'new input'),
            attachments: [],
            steer: false,
          },
          providerMeta: null,
        },
        {
          kind: 'permission-resolved',
          at: '2026-08-12T00:00:11.000Z',
          lifecycle: {
            kind: 'resolved',
            requestId: 'permission-1',
            incarnation: 'incarnation-1',
            decision: { allow: true },
          },
          providerMeta: null,
        },
        {
          kind: 'run-ended',
          at: '2026-08-12T00:00:12.000Z',
          outcome: 'interrupted',
          origin: 'core',
          providerMeta: null,
        },
      ]);

      expect(ledger.nativeActivityState('chat-1').providerWatermarkAt).toBe(PROVIDER_AT);
      expect(await activity.check('chat-1')).toBe(true);
    });
  });

  it('counts native-imported user rows and probes only the current binding', async () => {
    await withFixture(async ({ ledger, activity, lastActivity }) => {
      const view = ledger.initializeChat('chat-1', [
        ...baseRows(),
        {
          kind: 'user-input',
          at: EXTERNAL_AT,
          detail: {
            clientMessageId: null,
            message: new UserMessage(EXTERNAL_AT, 'imported input'),
            attachments: [],
            steer: false,
          },
          providerMeta: null,
        },
      ]);

      expect(ledger.nativeActivityState('chat-1').providerWatermarkAt).toBe(EXTERNAL_AT);
      expect(await activity.check('chat-1')).toBe(false);
      ledger.advanceContentStart('chat-1', view.viewId, 4);
      expect(await activity.check('chat-1')).toBe(false);
      expect(lastActivity).toHaveBeenCalledTimes(1);
    });
  });

  it('treats unavailable and failed probes as advisory', async () => {
    await withFixture(async ({ ledger, activity, setResult }) => {
      ledger.initializeChat('chat-1', baseRows());
      setResult({ kind: 'unavailable' });
      expect(await activity.check('chat-1')).toBe(false);
      setResult(new Error('probe failed'));
      expect(await activity.check('chat-1')).toBe(false);
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    });
  });
});

function baseRows() {
  return [
    {
      kind: 'session',
      at: SESSION_AT,
      detail: {
        agentSessionId: 'native-1',
        nativeSession: {
          ownerId: 'test',
          schemaVersion: 1,
          value: { path: '/tmp/native-1.jsonl' },
        },
        nativeSeedReceipt: null,
      },
      providerMeta: null,
    },
    {
      kind: 'provider-row',
      at: PROVIDER_AT,
      message: new AssistantMessage(PROVIDER_AT, 'observed answer'),
      providerMeta: null,
    },
  ];
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-native-activity-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(root), {
    now: () => '2026-08-12T00:00:20.000Z',
  });
  let result = { kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } };
  const lastActivity = mock(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const activity = new NativeTranscriptActivityService({
    ledger,
    registry: { getChat: () => ({ agentId: 'test' }) },
    integrations: {
      get: () => ({ nativeActivity: { lastActivity } }),
    },
  });
  try {
    await run({
      ledger,
      activity,
      lastActivity,
      setNativeAt(value) { result = { kind: 'ready', value: { lastEntryAt: value } }; },
      setResult(value) { result = value; },
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
