import crypto from 'node:crypto';
import { AgentCallError, type AgentDeliveryOutcome } from '../../../../server-agents/interface/src/index.ts';
import { ExecutorSessionLostError } from '../../../../server/common/executor-disconnect.ts';
import { AgentDirectory } from '../../../../server/controller/agents/directory.ts';
import { AgentEventBus } from '../../../../server/controller/agents/event-bus.ts';
import { dispatchListenersSequentially } from '../../../../server/controller/agents/listener-dispatch.ts';
import { retryAfterSessionLoss } from '../../../../server/controller/agents/session-loss-retry.ts';
import { operationIdentity, operationMetadata } from '../../../../server/controller/agents/turn-operation.ts';
import type { TurnCommandType } from '../../../../server/controller/lib/turn-identity.ts';

function tryResult<T>(read: () => T) {
  try {
    return read();
  } catch (error) {
    const { message, code } = error as Error & { code?: string };
    return { error: message, code: code ?? null };
  }
}

export function directoryTrace(spec: { executorId?: string | null; ready: boolean }) {
  const calls: unknown[] = [];
  const directory = new AgentDirectory({
    requireIntegration(target) {
      calls.push(['require', target.executorId, target.agentId]);
      throw new Error('integration unavailable');
    },
    knownIntegration(target) {
      calls.push(['known', target.executorId, target.agentId]);
      return null;
    },
    integrationsFor(executorId) {
      calls.push(['list', executorId]);
      return { list: () => [] } as ReturnType<ConstructorParameters<typeof AgentDirectory>[0]['integrationsFor']>;
    },
    isReady(executorId) {
      calls.push(['ready', executorId]);
      return spec.ready;
    },
  });
  const { executorId } = spec;
  const values = [
    directory.has('agent', executorId),
    directory.get('agent', executorId),
    tryResult(() => directory.require('agent', executorId)),
    directory.list(executorId),
    directory.isReady(executorId),
    tryResult(() => directory.requireReady(executorId) ?? null),
  ];
  return { values, calls };
}

export function turnOperationTrace(spec: {
  epoch?: string; ids: { clientRequestId?: string; turnId?: string; clientMessageId?: string };
  commandType: TurnCommandType;
}) {
  let generated = 0;
  const randomUUID = crypto.randomUUID;
  crypto.randomUUID = (() => `id-${++generated}`) as typeof randomUUID;
  try {
    const value = tryResult(() => {
      const operation = operationIdentity({ agentOwnershipEpoch: spec.epoch }, spec.ids, spec.commandType);
      return { operation, metadata: operationMetadata(operation) };
    });
    return { value, generated };
  } finally {
    crypto.randomUUID = randomUUID;
  }
}

export async function sessionLossRetryTrace(spec: {
  steps: Array<'ok' | 'plain' | 'other' | AgentDeliveryOutcome>; abortOn?: number;
}) {
  const controller = new AbortController();
  let calls = 0;
  const step = async () => {
    const value = spec.steps[Math.min(calls++, spec.steps.length - 1)];
    if (calls === spec.abortOn) controller.abort(new Error('Stopped'));
    if (value === 'ok') return 'resolved';
    if (value === 'plain') throw new AgentCallError('unknown', 'Live-session failure');
    if (value === 'other') throw new Error('Other failure');
    throw new ExecutorSessionLostError(value, 'Lost session');
  };
  try {
    return { value: await retryAfterSessionLoss(step, controller.signal), calls };
  } catch (error) {
    const failure = error as Error;
    return { error: failure.message, name: failure.name, calls };
  }
}

export async function listenerDispatchTrace() {
  const events: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const dispatched = dispatchListenersSequentially([
    () => { events.push('sync'); },
    () => { throw new Error('sync failure'); },
    async () => { events.push('await'); await pending; throw new Error('async failure'); },
    () => { events.push('last'); },
  ], [], (error) => { events.push((error as Error).message); });
  const inline = [...events];
  release();
  await dispatched;
  return { inline, events };
}

const CHAT = 'chat-1';
const turn = (turnId: string) => ({ commandType: 'agent-run' as const, clientRequestId: `request-${turnId}`, turnId });
const end = (outcome: 'finished' | 'interrupted' | 'failed', error?: { code: string; message?: string }) => ({
  ordinal: 1, at: '2026-08-12T00:00:00.000Z', providerMeta: null,
  kind: 'run-ended' as const, origin: 'provider' as const, outcome, ...(error ? { error } : {}),
});

export async function eventBusTrace(spec: string) {
  const bus = new AgentEventBus();
  const effects: unknown[] = [];
  bus.onFinished((chat, exit, metadata, outcome) => { effects.push(['finished', chat, exit, metadata?.turnId, outcome]); });
  bus.onFailed((chat, message, code, metadata) => { effects.push(['failed', chat, message, code, metadata?.turnId]); });
  bus.onSessionCreated(() => { throw new Error('synthetic listener failure'); });
  const listener = (chat: string) => { effects.push(['session', chat]); };
  bus.onSessionCreated(listener);
  bus.onSessionCreated(listener);
  bus.onRunSteerable((chat) => { effects.push(['steerable', chat]); });

  const values: unknown[] = [];
  if (spec === 'listeners') {
    bus.onSessionCreated(() => { bus.onSessionCreated((chat) => { effects.push(['added', chat]); }); });
    await bus.publishSession(CHAT);
    await bus.publishRunSteerable(CHAT);
  } else {
    bus.trackTurn(CHAT, turn('first'));
    if (spec === 'conflict') {
      const copy = bus.getActiveTurn(CHAT)!;
      copy.turnId = 'mutated';
      values.push(tryResult(() => bus.trackTurn(CHAT, turn('successor')) ?? null));
      values.push(bus.getActiveTurn(CHAT)?.turnId ?? null);
    } else if (spec === 'settled') {
      bus.settleTurn(CHAT, turn('other'));
      values.push(bus.getActiveTurn(CHAT)?.turnId ?? null);
      bus.settleTurn(CHAT, turn('first'));
      values.push(bus.getActiveTurn(CHAT)?.turnId ?? null);
      await bus.publishRunEnded(CHAT, 'first', end('failed', { code: 'START_FAILED' }));
    } else if (spec === 'default-failure') {
      await bus.publishRunEnded(CHAT, 'first', end('failed'));
    } else if (spec === 'completed') {
      await bus.publishRunEnded(CHAT, 'first', end('interrupted'));
      await bus.publishRunEnded(CHAT, 'first', end('finished'));
      bus.trackTurn(CHAT, turn('successor'));
      await bus.publishRunFailed(CHAT, 'first', { code: 'FAILED' });
    } else if (spec === 'stale') {
      await bus.publishRunEnded(CHAT, 'other', end('finished'));
    } else if (spec === 'cleared') {
      bus.trackTurn(CHAT, { turnId: '', clientRequestId: '', clientMessageId: 'message' });
      await bus.publishRunEnded(CHAT, 'first', end('finished'));
    }
  }
  return { values, effects, active: bus.getActiveTurn(CHAT)?.turnId ?? null };
}
