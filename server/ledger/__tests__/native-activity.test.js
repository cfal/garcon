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

  it('coalesces requested checks per chat and releases the slot after settlement', async () => {
    await withFixture(async ({ ledger, activity, lastActivity, setNativeAt, setResult }) => {
      ledger.initializeChat('chat-1', baseRows());
      const pending = deferred();
      setResult(pending.promise);

      activity.requestCheck('chat-1', 'open');
      activity.requestCheck('chat-1', 'pre-resume');

      expect(lastActivity).toHaveBeenCalledTimes(1);
      pending.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });
      await waitFor(() => ledger.currentRows('chat-1').some((row) => row.kind === 'notice'));

      setNativeAt('2026-08-12T00:00:04.000Z');
      activity.requestCheck('chat-1', 'open');
      await waitFor(() => lastActivity.mock.calls.length === 2);

      expect(lastActivity).toHaveBeenCalledTimes(2);
    });
  });

  it('aborts a stalled requested check and releases its coalescing slot', async () => {
    await withFixture(async ({ ledger, activity, lastActivity, setResult }) => {
      ledger.initializeChat('chat-1', baseRows());
      setResult(new Promise(() => {}));

      activity.requestCheck('chat-1', 'open');
      expect(lastActivity).toHaveBeenCalledTimes(1);
      const firstSignal = lastActivity.mock.calls[0][1];
      expect(firstSignal).toBeInstanceOf(AbortSignal);
      expect(await waitForAbort(firstSignal)).toBe(true);

      for (let attempt = 0; attempt < 100 && lastActivity.mock.calls.length < 2; attempt += 1) {
        activity.requestCheck('chat-1', 'pre-resume');
        await Bun.sleep(1);
      }

      expect(lastActivity).toHaveBeenCalledTimes(2);
      const secondSignal = lastActivity.mock.calls[1][1];
      expect(secondSignal).toBeInstanceOf(AbortSignal);
      expect(await waitForAbort(secondSignal)).toBe(true);
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    }, { probeTimeoutMs: 10 });
  });

  it('logs stalled requested checks with structured context', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = mock((...args) => warnings.push(args));

    try {
      await withFixture(async ({ ledger, activity, lastActivity, setResult }) => {
        ledger.initializeChat('chat-1', baseRows());
        setResult(new Promise(() => {}));

        activity.requestCheck('chat-1', 'open');
        expect(await waitForAbort(lastActivity.mock.calls[0][1])).toBe(true);
        await waitForWarnings(warnings);

        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some((entry) => {
          const details = entry.find((value) => value && typeof value === 'object');
          return details?.chatId === 'chat-1' && details?.reason === 'open';
        })).toBe(true);
      }, { probeTimeoutMs: 10 });
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not include provider error content in requested-check diagnostics', async () => {
    const privateContent = 'private-native-provider-content';
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = mock((...args) => warnings.push(args));

    try {
      await withFixture(async ({ ledger, activity, setResult }) => {
        ledger.initializeChat('chat-1', baseRows());
        setResult(new Error(privateContent));

        activity.requestCheck('chat-1', 'pre-resume');
        await waitForWarnings(warnings);

        expect(warnings.length).toBeGreaterThan(0);
        expect(JSON.stringify(warnings)).not.toContain(privateContent);
        expect(warnings.some((entry) => {
          const details = entry.find((value) => value && typeof value === 'object');
          return details?.chatId === 'chat-1' && details?.reason === 'pre-resume';
        })).toBe(true);
      });
    } finally {
      console.warn = originalWarn;
    }
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

  it('does not probe native history while the execution coordinator owns the chat', async () => {
    await withFixture(async ({ ledger, activity, lastActivity }) => {
      ledger.initializeChat('chat-1', baseRows());

      expect(await activity.check('chat-1')).toBe(false);
      expect(lastActivity).not.toHaveBeenCalled();
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    }, { ownsExecution: () => true });
  });

  it('drops a pending native result when execution starts before the probe settles', async () => {
    await withFixture(async ({ ledger, activity, lastActivity, setResult }) => {
      ledger.initializeChat('chat-1', baseRows());
      const pending = deferred();
      setResult(pending.promise);

      const check = activity.check('chat-1');
      expect(lastActivity).toHaveBeenCalledTimes(1);
      ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      pending.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });

      expect(await check).toBe(false);
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    });
  });

  it('drops a pending native result when the transcript view is replaced', async () => {
    await withFixture(async ({ ledger, activity, lastActivity, setResult }) => {
      const current = ledger.initializeChat('chat-1', baseRows());
      const pending = deferred();
      setResult(pending.promise);

      const check = activity.check('chat-1');
      expect(lastActivity).toHaveBeenCalledTimes(1);
      const staging = ledger.stageView('chat-1', baseRows(), 1);
      ledger.replaceCurrentView('chat-1', current.viewId, staging.viewId);
      pending.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });

      expect(await check).toBe(false);
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    });
  });

  it('drops a pending native result when the current native session changes', async () => {
    await withFixture(async ({ ledger, activity, lastActivity, setResult }) => {
      ledger.initializeChat('chat-1', baseRows());
      const pending = deferred();
      setResult(pending.promise);

      const check = activity.check('chat-1');
      expect(lastActivity).toHaveBeenCalledTimes(1);
      ledger.openProducer('chat-1', 'test').sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'native-2',
          nativeSession: {
            ownerId: 'test',
            schemaVersion: 1,
            value: { path: '/tmp/native-2.jsonl' },
          },
          nativeSeedReceipt: null,
        },
      });
      pending.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });

      expect(await check).toBe(false);
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    });
  });

  it('drops a pending native result when provider output advances the watermark', async () => {
    await withFixture(async ({ ledger, activity, lastActivity, setResult }) => {
      ledger.initializeChat('chat-1', baseRows());
      const pending = deferred();
      setResult(pending.promise);

      const check = activity.check('chat-1');
      expect(lastActivity).toHaveBeenCalledTimes(1);
      ledger.openProducer('chat-1', 'test').sink.publish({
        type: 'rows',
        rows: [{
          message: new AssistantMessage('2026-08-12T00:00:02.500Z', 'late provider output'),
        }],
      });
      pending.resolve({
        kind: 'ready',
        value: { lastEntryAt: '2026-08-12T00:00:04.000Z' },
      });

      expect(await check).toBe(false);
      expect(ledger.currentRows('chat-1').some((row) => row.kind === 'notice')).toBe(false);
    });
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition did not settle within the microtask budget.');
}

async function waitForAbort(signal) {
  if (signal.aborted) return true;
  return Promise.race([
    new Promise((resolve) => signal.addEventListener('abort', () => resolve(true), { once: true })),
    Bun.sleep(250).then(() => false),
  ]);
}

async function waitForWarnings(warnings) {
  for (let attempt = 0; attempt < 100 && warnings.length === 0; attempt += 1) {
    await Bun.sleep(1);
  }
}

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

async function withFixture(run, options = {}) {
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
    ownsExecution: (chatId) => ledger.isRunActive(chatId),
    ...options,
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
