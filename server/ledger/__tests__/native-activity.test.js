import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import {
  NATIVE_TRANSCRIPT_DRIFT_NOTICE,
  NativeTranscriptActivityService,
} from '../native-activity.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const CHAT_ID = 'synthetic-chat';
const SESSION_AT = '2026-08-12T00:00:01.000Z';
const PROVIDER_AT = '2026-08-12T00:00:02.000Z';
const EXTERNAL_AT = '2026-08-12T00:00:03.000Z';
const IMPORTED_AT = '2026-08-12T00:00:04.000Z';

describe('NativeTranscriptActivityService', () => {
  it('[TLV5-L09.05-CORE-UNIT-01] emits repeatable transient warnings without mutating the ledger', async () => {
    await withLedger(async ({ ledger }) => {
      ledger.initializeChat(CHAT_ID, baseRows());
      const rowsBefore = ledger.currentRows(CHAT_ID);
      const viewBefore = ledger.currentView(CHAT_ID);
      const watermarkBefore = ledger.highWatermark(CHAT_ID);
      const notices = [];
      const lastActivity = mock(async () => ({
        kind: 'ready',
        value: { lastEntryAt: EXTERNAL_AT },
      }));
      const options = {
        ledger,
        registry: { getChat: () => ({ agentId: 'test-a' }) },
        integrations: {
          get: () => ({ nativeActivity: { lastActivity } }),
        },
        ownsExecution: () => false,
        notifyOperationalNotice: (chatId, noticeType, content) => {
          notices.push({ chatId, noticeType, content });
        },
      };
      const activity = new NativeTranscriptActivityService(options);

      activity.requestCheck(CHAT_ID, 'activation');
      await waitFor(() => notices.length === 1);
      await drainMicrotasks();
      activity.requestCheck(CHAT_ID, 'activation');
      await waitFor(() => notices.length === 2);
      await drainMicrotasks();
      new NativeTranscriptActivityService(options).requestCheck(CHAT_ID, 'activation');
      await waitFor(() => notices.length === 3);

      expect(notices).toEqual(Array.from({ length: 3 }, () => ({
        chatId: CHAT_ID,
        noticeType: 'warning',
        content: NATIVE_TRANSCRIPT_DRIFT_NOTICE,
      })));
      expect(lastActivity).toHaveBeenCalledTimes(3);
      expect(ledger.currentRows(CHAT_ID)).toEqual(rowsBefore);
      expect(ledger.currentView(CHAT_ID)).toEqual(viewBefore);
      expect(ledger.highWatermark(CHAT_ID)).toEqual(watermarkBefore);
    });
  });

  it('[TLV5-L09.04-STORE-UNIT-01] qualifies the provider watermark by ordinal and timestamp', async () => {
    await withLedger(async ({ ledger, store }) => {
      const view = ledger.initializeChat(CHAT_ID, [
        ...baseRows({ providerAt: SESSION_AT }),
        coreInput('core input', 'core-input-1', IMPORTED_AT),
        {
          kind: 'notice',
          at: IMPORTED_AT,
          message: 'Ordinary durable notice.',
          detail: { type: 'ordinary-notice' },
          providerMeta: null,
        },
        {
          kind: 'permission-resolved',
          at: IMPORTED_AT,
          lifecycle: {
            kind: 'resolved',
            permissionOccurrenceId: 'synthetic-permission',
            decision: { allow: true },
          },
          providerMeta: null,
        },
        {
          kind: 'run-ended',
          at: IMPORTED_AT,
          outcome: 'interrupted',
          origin: 'core',
          providerMeta: null,
        },
      ]);

      expect(ledger.nativeActivityState(CHAT_ID).providerWatermark).toEqual({
        ordinal: 2,
        at: SESSION_AT,
      });

      store.append(CHAT_ID, view.viewId, [{
        kind: 'provider-row',
        at: SESSION_AT,
        message: new AssistantMessage(SESSION_AT, 'provider timestamp collision'),
        providerMeta: null,
      }]);
      expect(ledger.nativeActivityState(CHAT_ID).providerWatermark).toEqual({
        ordinal: 7,
        at: SESSION_AT,
      });

      store.append(CHAT_ID, view.viewId, [{
        kind: 'notice',
        at: IMPORTED_AT,
        message: 'Agent requested chat ID',
        detail: { type: 'chat-id-request', title: 'Request: Garcon Chat ID' },
        providerMeta: null,
      }]);
      expect(ledger.nativeActivityState(CHAT_ID).providerWatermark).toEqual({
        ordinal: 8,
        at: IMPORTED_AT,
      });

      store.append(CHAT_ID, view.viewId, [{
        kind: 'notice',
        at: '2099-01-01T00:00:00.000Z',
        message: 'Sent chat ID 1787836573296800 to agent',
        detail: {
          type: 'chat-id-disclosure',
          delivery: 'input',
          title: 'Response: Garcon Chat ID',
        },
        providerMeta: null,
      }]);
      expect(ledger.nativeActivityState(CHAT_ID).providerWatermark).toEqual({
        ordinal: 8,
        at: IMPORTED_AT,
      });

      store.append(CHAT_ID, view.viewId, [{
        kind: 'user-input',
        at: IMPORTED_AT,
        detail: {
          clientMessageId: null,
          message: new UserMessage(IMPORTED_AT, 'synthetic imported input'),
          attachments: [],
          steer: false,
        },
        providerMeta: null,
      }]);
      expect(ledger.nativeActivityState(CHAT_ID).providerWatermark).toEqual({
        ordinal: 10,
        at: IMPORTED_AT,
      });
    });
  });

  it('coalesces equal pending work and releases only the completed attempt', async () => {
    const fixture = serviceFixture();
    const first = deferred();
    fixture.enqueueProbe(first.promise, { kind: 'unavailable' });

    fixture.activity.requestCheck(CHAT_ID, 'activation');
    fixture.activity.requestCheck(CHAT_ID, 'activation');
    expect(fixture.probeCalls).toHaveLength(1);

    first.resolve({ kind: 'unavailable' });
    await waitFor(() => fixture.timers[0]?.cancelled === true);
    fixture.activity.requestCheck(CHAT_ID, 'activation');
    await waitFor(() => fixture.probeCalls.length === 2);
    await waitFor(() => fixture.timers[1]?.cancelled === true);
  });

  it('[TLV5-L09.04-CORE-UNIT-01] supersedes and fences every changed eligibility dimension', async () => {
    const scenarios = eligibilityChanges();

    for (const scenario of scenarios) {
      const fenced = serviceFixture();
      const heldFence = deferred();
      fenced.enqueueProbe(heldFence.promise);
      fenced.activity.requestCheck(CHAT_ID, 'activation');
      scenario.mutate(fenced);
      heldFence.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });
      await waitFor(() => fenced.timers[0]?.cancelled === true);
      if (fenced.notices.length !== 0) {
        throw new Error(`${scenario.name} escaped the result fence`);
      }
      expect(fenced.probeCalls[0].signal.aborted).toBe(false);

      const superseded = serviceFixture();
      const oldProbe = deferred();
      const replacementProbe = deferred();
      superseded.enqueueProbe(oldProbe.promise, replacementProbe.promise);
      superseded.activity.requestCheck(CHAT_ID, 'activation');
      scenario.mutate(superseded);
      superseded.activity.requestCheck(CHAT_ID, 'activation');

      expect(superseded.probeCalls).toHaveLength(2);
      expect(superseded.probeCalls[0].signal.aborted).toBe(true);
      await waitFor(() => superseded.timers[0]?.cancelled === true);
      oldProbe.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });
      await drainMicrotasks();
      superseded.activity.requestCheck(CHAT_ID, 'activation');
      if (superseded.probeCalls.length !== 2) {
        throw new Error(`${scenario.name} completion cleared its replacement token`);
      }
      replacementProbe.resolve({ kind: 'unavailable' });
      await waitFor(() => superseded.timers[1]?.cancelled === true);
      expect(superseded.notices).toEqual([]);
    }
  });

  it('[TLV5-L09.04-CORE-UNIT-02] contains ineligible, failed, owned, and timed-out probes', async () => {
    const ineligible = [
      (fixture) => fixture.setOwned(true),
      (fixture) => fixture.setChatExists(false),
      (fixture) => fixture.setIntegrationAvailable(false),
      (fixture) => fixture.updateState((current) => ({ ...current, session: null })),
      (fixture) => fixture.updateState((current) => ({ ...current, providerWatermark: null })),
    ];
    for (const makeIneligible of ineligible) {
      const fixture = serviceFixture();
      makeIneligible(fixture);
      fixture.activity.requestCheck(CHAT_ID, 'activation');
      expect(fixture.probeCalls).toEqual([]);
      expect(fixture.timers).toEqual([]);
    }

    const quietResults = [
      { kind: 'unavailable' },
      { kind: 'ready', value: { lastEntryAt: null } },
      { kind: 'ready', value: { lastEntryAt: 'not-a-timestamp' } },
      { kind: 'ready', value: { lastEntryAt: PROVIDER_AT } },
      { kind: 'ready', value: { lastEntryAt: SESSION_AT } },
    ];
    for (const result of quietResults) {
      const fixture = serviceFixture();
      fixture.enqueueProbe(result);
      fixture.activity.requestCheck(CHAT_ID, 'activation');
      await waitFor(() => fixture.timers[0]?.cancelled === true);
      expect(fixture.notices).toEqual([]);
    }

    const ownership = serviceFixture();
    const heldOwnership = deferred();
    ownership.enqueueProbe(heldOwnership.promise);
    ownership.activity.requestCheck(CHAT_ID, 'activation');
    ownership.setOwned(true);
    heldOwnership.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });
    await waitFor(() => ownership.timers[0]?.cancelled === true);
    expect(ownership.notices).toEqual([]);

    const privateProviderContent = 'synthetic-private-provider-content';
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = mock((...args) => warnings.push(args));
    try {
      const failed = serviceFixture();
      failed.enqueueProbe(new Error(privateProviderContent));
      failed.activity.requestCheck(CHAT_ID, 'activation');
      await waitFor(() => failed.timers[0]?.cancelled === true);
      expect(failed.notices).toEqual([]);
      expect(JSON.stringify(warnings)).not.toContain(privateProviderContent);
      expect(JSON.stringify(warnings)).toContain('NATIVE_ACTIVITY_PROBE_FAILED');
    } finally {
      console.warn = originalWarn;
    }

    const timedOut = serviceFixture();
    const stalled = deferred();
    timedOut.enqueueProbe(stalled.promise, { kind: 'unavailable' });
    timedOut.activity.requestCheck(CHAT_ID, 'activation');
    expect(timedOut.timers[0].delay).toBe(5_000);
    timedOut.timers[0].fire();
    await waitFor(() => timedOut.probeCalls[0].signal.aborted);
    await waitFor(() => timedOut.timers[0].cancelled);
    timedOut.activity.requestCheck(CHAT_ID, 'activation');
    await waitFor(() => timedOut.probeCalls.length === 2);
    await waitFor(() => timedOut.timers[1]?.cancelled === true);
    stalled.resolve({ kind: 'ready', value: { lastEntryAt: EXTERNAL_AT } });
    await drainMicrotasks();
    expect(timedOut.notices).toEqual([]);
  });
});

function eligibilityChanges() {
  return [
    {
      name: 'transcript view',
      mutate: (fixture) => fixture.updateState((current) => ({
        ...current,
        viewId: 'synthetic-view-b',
        session: { ...current.session, viewId: 'synthetic-view-b' },
      })),
    },
    {
      name: 'agent',
      mutate: (fixture) => fixture.setAgentId('test-b'),
    },
    {
      name: 'session row',
      mutate: (fixture) => fixture.updateState((current) => ({
        ...current,
        session: { ...current.session, ordinal: current.session.ordinal + 1 },
      })),
    },
    {
      name: 'native reference',
      mutate: (fixture) => fixture.updateState((current) => ({
        ...current,
        session: {
          ...current.session,
          detail: {
            ...current.session.detail,
            nativeSession: syntheticNativeSession('synthetic-native-session-b'),
          },
        },
      })),
    },
    {
      name: 'provider ordinal at the same timestamp',
      mutate: (fixture) => fixture.updateState((current) => ({
        ...current,
        providerWatermark: {
          ...current.providerWatermark,
          ordinal: current.providerWatermark.ordinal + 1,
        },
      })),
    },
    {
      name: 'provider timestamp',
      mutate: (fixture) => fixture.updateState((current) => ({
        ...current,
        providerWatermark: { ...current.providerWatermark, at: EXTERNAL_AT },
      })),
    },
  ];
}

function serviceFixture() {
  let currentState = syntheticActivityState();
  let agentId = 'test-a';
  let owned = false;
  let chatExists = true;
  let integrationAvailable = true;
  const queuedProbeResults = [];
  const probeCalls = [];
  const notices = [];
  const timers = [];
  const lastActivity = mock((nativeSession, signal) => {
    probeCalls.push({ nativeSession, signal, agentId });
    const result = queuedProbeResults.shift() ?? { kind: 'unavailable' };
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const activity = new NativeTranscriptActivityService({
    ledger: { nativeActivityState: () => currentState },
    registry: { getChat: () => chatExists ? { agentId } : null },
    integrations: {
      get: () => integrationAvailable ? { nativeActivity: { lastActivity } } : null,
    },
    ownsExecution: () => owned,
    notifyOperationalNotice: (chatId, noticeType, content) => {
      notices.push({ chatId, noticeType, content });
    },
    scheduleTimeout(callback, delay) {
      const timer = {
        delay,
        cancelled: false,
        fire() {
          if (!timer.cancelled) callback();
        },
      };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
  });

  return {
    activity,
    notices,
    probeCalls,
    timers,
    enqueueProbe(...results) { queuedProbeResults.push(...results); },
    setAgentId(value) { agentId = value; },
    setOwned(value) { owned = value; },
    setChatExists(value) { chatExists = value; },
    setIntegrationAvailable(value) { integrationAvailable = value; },
    updateState(update) { currentState = update(currentState); },
  };
}

function syntheticActivityState() {
  return {
    viewId: 'synthetic-view-a',
    session: {
      kind: 'session',
      viewId: 'synthetic-view-a',
      ordinal: 1,
      at: SESSION_AT,
      detail: {
        agentSessionId: 'synthetic-agent-session-a',
        nativeSession: syntheticNativeSession('synthetic-native-session-a'),
        nativeSeedReceipt: null,
      },
      providerMeta: null,
    },
    providerWatermark: { ordinal: 2, at: PROVIDER_AT },
  };
}

function syntheticNativeSession(sessionId) {
  return {
    ownerId: 'test-a',
    schemaVersion: 1,
    value: { sessionId },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition did not settle within the microtask budget.');
}

async function drainMicrotasks() {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
}

function baseRows(options = {}) {
  const providerAt = options.providerAt ?? PROVIDER_AT;
  return [
    {
      kind: 'session',
      at: SESSION_AT,
      detail: {
        agentSessionId: 'synthetic-agent-session-a',
        nativeSession: syntheticNativeSession('synthetic-native-session-a'),
        nativeSeedReceipt: null,
      },
      providerMeta: null,
    },
    {
      kind: 'provider-row',
      at: providerAt,
      message: new AssistantMessage(providerAt, 'synthetic observed output'),
      providerMeta: null,
    },
  ];
}

function coreInput(content, clientMessageId, at) {
  return {
    kind: 'user-input',
    at,
    detail: {
      clientMessageId,
      message: new UserMessage(at, content),
      attachments: [],
      steer: false,
    },
    providerMeta: null,
  };
}

async function withLedger(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-native-activity-'));
  const store = new TranscriptLedgerStore(root, {
    now: () => '2026-08-12T00:00:20.000Z',
  });
  const ledger = new TranscriptLedgerService(store, {
    now: () => '2026-08-12T00:00:20.000Z',
  });
  try {
    await run({ ledger, store });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
