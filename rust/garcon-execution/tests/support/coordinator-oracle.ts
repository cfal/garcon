import crypto from 'node:crypto';
import { DomainError } from '../../../../server/common/domain-error.ts';
import { KeyedPromiseLock } from '../../../../server/common/keyed-lock.ts';
import { ChatExecutionCoordinator } from '../../../../server/controller/chat-execution/chat-execution-coordinator.ts';
import { InMemoryChatExecutionControlRepository } from '../../../../server/controller/chat-execution/chat-execution-control-repository.ts';

const CHAT = 'chat-1';
const VIEW = 'view-1';
const TIME = '1970-01-01T00:01:00.123Z';
const FIRST = { turnId: 'first' };
const CASES = [
  'provider', 'startup', 'coalesced', 'terminal', 'snapshot', 'hidden', 'hidden-paused',
  'hidden-missing', 'receipt', 'receipt-failure', 'stale', 'fallback', 'ambiguous', 'plain-stop',
  'shutdown', 'deletion', 'suppressed-drain',
] as const;
type Scenario = typeof CASES[number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function result(run: () => unknown) {
  try { return await run() ?? null; }
  catch (error) {
    const failure = error as Error & { code?: string };
    return { code: failure.code ?? null, message: failure.message };
  }
}

export async function coordinatorTrace(scenario: Scenario) {
  const realDate = globalThis.Date;
  const realUuid = crypto.randomUUID;
  let next = 0;
  globalThis.Date = class extends realDate {
    constructor() { super(60_123); }
    static now() { return 60_123; }
  } as typeof Date;
  crypto.randomUUID = (() => `id-${++next}`) as typeof realUuid;
  try {
    return await trace(scenario);
  } finally {
    globalThis.Date = realDate;
    crypto.randomUUID = realUuid;
  }
}

async function trace(scenario: Scenario) {
  const effects: unknown[] = [];
  const values: unknown[] = [];
  const launched = deferred<string>();
  const released = deferred<void>();
  const successor = deferred<string>();
  const successorReleased = deferred<void>();
  const aborting = deferred<void>();
  const abort = deferred<boolean>();
  const settling = deferred<void>();
  const settlement = deferred<{ kind: 'settled' }>();
  let ready = !['receipt', 'receipt-failure', 'stale'].includes(scenario);
  let running = scenario === 'provider';
  const repository = new InMemoryChatExecutionControlRepository('server');
  if (scenario === 'hidden-paused') {
    repository.save(CHAT, { ...repository.load(CHAT), pause: { id: 'pause', kind: 'manual', pausedAt: TIME } });
  }
  const execution = new ChatExecutionCoordinator({
    async runAgentTurn(_chat, content, options) {
      effects.push(['run', content, options.turnId ?? null, options.transcriptViewId ?? null]);
      if (content === 'queued while stopping') {
        successor.resolve(options.turnId!);
        return successorReleased.promise;
      }
      launched.resolve(options.turnId!);
      if (scenario !== 'terminal') await released.promise;
    },
    captureSteerTarget: async () => ({ providerTurnId: 'target' }),
    async steerInput() {
      effects.push(['steer']);
      if (scenario === 'fallback') {
        throw new DomainError('STEER_TURN_CHANGED', 'The active turn changed before steering could be applied', 409);
      }
      return { kind: 'accepted' };
    },
    async abortSession() {
      effects.push(['abort']);
      aborting.resolve();
      return scenario === 'coalesced' || scenario === 'suppressed-drain' ? abort.promise : false;
    },
    isChatRunning: () => running,
  }, {
    hasMatchingInput: () => false,
    admitInput: async () => { effects.push(['direct-admission']); return { inserted: true }; },
    admitQueuedInput: () => { effects.push(['queued-admission']); return { inserted: true }; },
    discardPreparedInput: () => {},
  }, () => ({}), () => scenario !== 'hidden-missing',
  repository, {
    canDispatch: () => ready,
    isControlInputViewCurrent: () => scenario !== 'stale',
    projectAdmission: { assertAvailable: async () => {} },
    attachmentAdmission: { assertSupported: () => {} },
    selectionAdmissionLock: new KeyedPromiseLock(),
    workingDirectorySettlement: {
      settle() { settling.resolve(); return settlement.promise; },
    },
    appendControlReceipt(_chat, entry) {
      effects.push(['receipt', entry.content]);
      if (scenario === 'receipt-failure') throw new Error('receipt unavailable');
    },
  });
  execution.onSessionStopped((_chat, outcome, intent, turn) => {
    effects.push(['stopped', outcome, intent, turn?.turnId ?? null]);
  });
  const signal = new AbortController().signal;
  const input = {
    content: 'control', transcriptViewId: VIEW, createdAt: TIME,
    receipt: { title: 'Inter-agent message', content: 'control', detail: { type: 'inter-agent-message-received' as const, fromChatId: null } },
  };
  const run = (reservation: ReturnType<typeof execution.reserveDirectTurn>) =>
    execution.runReservedTurn(reservation, 'initial', FIRST);
  const terminal = async (turnId: string) => {
    settlement.resolve({ kind: 'settled' });
    await execution.onAgentTurnTerminal(CHAT, { turnId });
  };

  switch (scenario) {
    case 'provider':
      values.push(execution.ownsExecution(CHAT));
      values.push(await result(() => execution.reserveTranscriptSnapshot(CHAT)));
      running = false;
      values.push(execution.ownsExecution(CHAT));
      break;
    case 'startup': {
      const reservation = execution.reserveDirectTurn(CHAT, FIRST);
      const dispatched = run(reservation);
      await launched.promise;
      values.push((await execution.stopActiveTurn(CHAT)).outcome, reservation.executionAdmission.signal.aborted);
      const successor = execution.reserveDirectTurn(CHAT, { turnId: 'successor' });
      released.resolve();
      await dispatched;
      values.push(execution.ownsExecution(CHAT));
      await execution.releaseDirectTurn(successor);
      break;
    }
    case 'coalesced': {
      const first = execution.interruptActiveTurn(CHAT);
      const second = execution.interruptActiveTurn(CHAT);
      await aborting.promise;
      values.push(execution.isChatStopInFlight(CHAT));
      abort.resolve(false);
      values.push(...await Promise.all([first, second]));
      break;
    }
    case 'terminal': {
      await run(execution.reserveDirectTurn(CHAT, FIRST));
      execution.markRunTerminalCommitted(CHAT, FIRST.turnId);
      const ended = execution.onAgentTurnTerminal(CHAT, FIRST);
      await settling.promise;
      await execution.createChatQueueEntry(CHAT, 'queued');
      values.push(await execution.interruptActiveTurn(CHAT));
      values.push((await execution.stopActiveTurn(CHAT)).outcome, execution.ownsExecution(CHAT));
      settlement.resolve({ kind: 'settled' });
      await ended;
      break;
    }
    case 'snapshot': {
      const snapshot = execution.reserveTranscriptSnapshot(CHAT);
      values.push(await result(() => execution.reserveDirectTurn(CHAT, FIRST)));
      await execution.createChatQueueEntry(CHAT, 'queued');
      await execution.triggerDrain(CHAT);
      values.push(effects.length);
      await execution.releaseTranscriptSnapshot(snapshot);
      await terminal(await launched.promise);
      released.resolve();
      break;
    }
    case 'hidden':
    case 'hidden-paused':
    case 'hidden-missing': {
      values.push(await result(() => execution.deliverControlInput(CHAT, 'hidden', VIEW, null, signal, (turn) => {
        effects.push(['reserved', turn]);
      })));
      if (scenario === 'hidden') {
        values.push(execution.ownsExecution(CHAT), effects.length);
        await terminal(await launched.promise);
        released.resolve();
      }
      break;
    }
    case 'receipt':
    case 'receipt-failure':
    case 'stale':
      values.push(await execution.deliverServerControlInput(CHAT, input, signal));
      await execution.waitForExecutionOwners();
      ready = true;
      if (scenario === 'receipt') {
        const drain = execution.triggerDrain(CHAT);
        await terminal(await launched.promise);
        released.resolve();
        await drain;
      } else {
        values.push(await result(() => execution.triggerDrain(CHAT)));
      }
      break;
    case 'fallback':
    case 'ambiguous': {
      const reservation = execution.reserveDirectTurn(CHAT, FIRST);
      if (scenario === 'fallback') {
        const offer = await execution.offerServerControlInput(CHAT, input, signal, 123);
        values.push(offer.kind);
        if (offer.kind !== 'after-turn') throw new Error('expected captured attempt');
        await execution.releaseDirectTurn(reservation);
        await offer.turnSettled;
        ready = false;
        values.push(await execution.queueServerControlInput(CHAT, input, signal));
      } else {
        values.push(await result(() => execution.deliverServerControlInput(CHAT, input, signal)));
        await execution.releaseDirectTurn(reservation);
      }
      break;
    }
    case 'plain-stop':
      execution.reserveDirectTurn(CHAT, FIRST);
      await execution.createChatQueueEntry(CHAT, 'queued');
      values.push((await execution.stopActiveTurn(CHAT)).outcome);
      break;
    case 'suppressed-drain': {
      const dispatched = run(execution.reserveDirectTurn(CHAT, FIRST));
      await launched.promise;
      const stop = execution.stopActiveTurn(CHAT);
      await aborting.promise;
      await execution.createChatQueueEntry(CHAT, 'queued while stopping');
      await execution.triggerDrain(CHAT);
      abort.resolve(true);
      const stopped = await stop;
      values.push(stopped.outcome, stopped.control.pause?.kind ?? null);
      await terminal(await successor.promise);
      successorReleased.resolve();
      released.resolve();
      await dispatched;
      break;
    }
    case 'shutdown':
      execution.reserveDirectTurn(CHAT, FIRST);
      values.push(execution.beginShutdown());
      values.push(await result(() => execution.reserveDirectTurn('other', FIRST)));
      values.push(await execution.abortForShutdown(CHAT));
      break;
    case 'deletion':
      execution.reserveTranscriptSnapshot(CHAT);
      await execution.createChatQueueEntry(CHAT, 'queued');
      await execution.deleteChatQueueFile(CHAT);
      break;
  }
  await execution.waitForDispatches();
  await execution.waitForExecutionOwners();
  const state = await execution.readChatExecutionControl(CHAT);
  return {
    values, effects,
    owned: execution.ownsExecution(CHAT),
    entries: state.entries.map((entry) => entry.content),
    control: state.controlEntries.map((entry) => entry.content),
    pause: state.pause?.kind ?? null,
  };
}
