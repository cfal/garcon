import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentProducerNotification, ExecutorAvailability } from '@garcon/server-agent-interface';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import type { RemoteExecutorClient } from '../client/executor-client.js';
import type { Logger } from '../../common/log.js';
import { remoteFixture, requestFor } from './integration-fixture.js';

type Fixture = Awaited<ReturnType<typeof remoteFixture>>;
type Integration = Awaited<ReturnType<RemoteExecutorClient['getAgentIntegration']>>;

function capturingLogger() {
  const entries: { readonly level: 'warn' | 'error'; readonly message: unknown; readonly detail: unknown }[] = [];
  const logger = {
    debug() {}, info() {},
    warn(message: unknown, detail: unknown) { entries.push({ level: 'warn', message, detail }); },
    error(message: unknown, detail: unknown) { entries.push({ level: 'error', message, detail }); },
  } satisfies Logger;
  return { entries, logger };
}

// Row and gap events in arrival order; session and run facts are left out.
function deliveries(integration: Integration) {
  const delivered: string[] = [];
  integration.producers.subscribe(({ event }) => {
    if (event.type === 'rows') delivered.push(`rows:${(event.rows[0]!.message as AssistantMessage).content}`);
    else if (event.type === 'publication-gap' || event.type === 'publication-failed') delivered.push(event.type);
  });
  return delivered;
}

function workerSessions(fixture: Fixture) {
  const counter = { sessions: 0 };
  fixture.worker.onSession(() => { counter.sessions += 1; });
  return counter;
}

function nextAvailability(executor: RemoteExecutorClient, value: ExecutorAvailability) {
  const reached = Promise.withResolvers<void>();
  const off = executor.onAvailabilityChanged((next) => { if (next === value) { off(); reached.resolve(); } });
  return reached.promise;
}

function row(content: string): AgentRuntimeEvent {
  return { type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', content) }] };
}

// A message type this controller cannot parse, as a worker from a mismatched or faulty build would send.
const UNDECODABLE_ROW = {
  type: 'rows', rows: [{ message: { type: 'synthetic-unknown-message', timestamp: '2026-01-01T00:00:00Z' } }],
} as unknown as AgentRuntimeEvent;

function undecodablePermissionRequest(runId: string): AgentRuntimeEvent {
  const permissionOccurrenceId = crypto.randomUUID();
  return {
    type: 'permission', runId,
    lifecycle: {
      kind: 'requested', permissionOccurrenceId, options: [],
      requestedTool: { type: 'synthetic-unknown-tool', timestamp: '2026-01-01T00:00:00Z' },
    },
    decision: { permissionOccurrenceId, respond: async () => {} },
  } as unknown as AgentRuntimeEvent;
}

const UNREADABLE_EVENT_FAILURE = {
  code: 'OUTCOME_UNKNOWN',
  message: 'An event from the executor could not be read, so this turn\'s outcome is unknown. Native history may contain additional output.',
};

async function runningTurn(dialer: 'controller' | 'worker') {
  const log = capturingLogger();
  const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { client: { logger: log.logger } });
  const integration = await fixture.executor.getAgentIntegration('test');
  const request = await requestFor(integration);
  await integration.execution.start(request);
  const publish = fixture.generations[0]!.nativePublishers[0]!;
  return { fixture, integration, request, publish, log };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`malformed and inherited message types remain publication gaps (${dialer} dials)`, async () => {
    const { fixture, integration, publish } = await runningTurn(dialer);
    try {
      const delivered = deliveries(integration);
      const messages = [null, 42, [], ...['constructor', 'toString', '__proto__', 'unknown-type'].map(type => ({ type }))];
      for (const [index, message] of messages.entries()) {
        publish({ type: 'rows', rows: [{ message }] } as unknown as AgentRuntimeEvent);
        publish(row(`valid-${index}`));
      }
      await integration.execution.runningSessions();
      expect(delivered).toEqual(messages.flatMap((_message, index) => ['publication-gap', `rows:valid-${index}`]));
      expect(fixture.executor.availability).toBe('ready');
    } finally { await fixture.dispose(); }
  });

  test(`a steerable run reaches the controller with its run ID (${dialer} dials)`, async () => {
    const { fixture, integration, request, publish } = await runningTurn(dialer);
    try {
      const steerable: string[] = [];
      integration.producers.subscribe(({ event }) => {
        if (event.type === 'steerable') steerable.push(event.runId);
      });
      publish({ type: 'steerable' });
      await integration.execution.runningSessions();

      expect(steerable).toEqual([request.runId]);
    } finally { await fixture.dispose(); }
  });

  test(`row batches the controller cannot decode arrive as one loss per run of them and keep the session (${dialer} dials)`, async () => {
    const { fixture, integration, request, publish, log } = await runningTurn(dialer);
    try {
      const delivered = deliveries(integration);
      const counter = workerSessions(fixture);
      publish(UNDECODABLE_ROW);
      publish(UNDECODABLE_ROW);
      publish(row('after'));
      publish(UNDECODABLE_ROW);
      await integration.execution.runningSessions();

      expect(delivered).toEqual(['publication-gap', 'rows:after', 'publication-gap']);
      expect(counter.sessions).toBe(1);
      expect(fixture.executor.availability).toBe('ready');
      expect(log.entries).toEqual([1, 2, 3].map(() => ({ level: 'warn', message: 'Executor producer event could not be decoded', detail: {
        integrationId: 'test', bindingId: request.producerBinding.id, seq: expect.any(Number), type: 'rows',
        reason: 'Unknown normalized message',
      } })));
    } finally { await fixture.dispose(); }
  });

  for (const [unreadable, event] of [
    ['publication failure detail', () => ({ type: 'publication-failed', error: { code: 42 } }) as unknown as AgentRuntimeEvent],
    ['permission request', (runId: string) => undecodablePermissionRequest(runId)],
    ['launch outcome', () => ({ type: 'launch-settled', runId: 42 }) as unknown as AgentRuntimeEvent],
  ] as const) {
    test(`an unreadable ${unreadable} fails its binding as an unknown outcome and keeps the session (${dialer} dials)`, async () => {
      const { fixture, integration, request, publish } = await runningTurn(dialer);
      try {
        const failures: AgentProducerNotification['event'][] = [];
        integration.producers.subscribe(({ event }) => { if (event.type === 'publication-failed') failures.push(event); });
        const delivered = deliveries(integration);
        const counter = workerSessions(fixture);
        publish(event(request.runId));
        publish(row('after the failure'));
        await integration.execution.runningSessions();

        expect(failures).toEqual([{ type: 'publication-failed', error: UNREADABLE_EVENT_FAILURE }]);
        expect(delivered).toEqual(['publication-failed']);
        expect(counter.sessions).toBe(1);
      } finally { await fixture.dispose(); }
    });
  }

  for (const [closed, replayed, closesOn] of [
    ['a binding that fails', (runId: string) => undecodablePermissionRequest(runId), 'publication-failed'],
    ['a binding its owner closes', () => row('during the gap'), 'rows'],
  ] as const) {
    test(`${closed} while a replacement session installs closes through that session (${dialer} dials)`, async () => {
      const { fixture, integration, request, publish } = await runningTurn(dialer);
      try {
        const worker = fixture.generations[0]!;
        const closes: Promise<void>[] = [];
        // Closes on the first replayed event, before the replacement session is ready, as the transcript route does.
        integration.producers.subscribe(({ binding, event }) => {
          if (event.type === closesOn && closes.length === 0) closes.push(integration.producers.close(binding));
        });
        const ready = nextAvailability(fixture.executor, 'ready');
        fixture.controller.disconnect(); fixture.worker.disconnect();
        publish(replayed(request.runId));
        await ready;

        expect(closes).toHaveLength(1);
        await closes[0];
        expect(worker.calls.abort).toBe(1);
      } finally { await fixture.dispose(); }
    });
  }

  test(`a listener that throws neither retires the session nor starves later listeners (${dialer} dials)`, async () => {
    const { fixture, integration, request, publish, log } = await runningTurn(dialer);
    try {
      integration.producers.subscribe(() => { throw new Error('Synthetic listener failure'); });
      const delivered = deliveries(integration);
      const counter = workerSessions(fixture);
      publish(row('one'));
      publish(row('two'));
      await integration.execution.runningSessions();

      expect(delivered).toEqual(['rows:one', 'rows:two']);
      expect(counter.sessions).toBe(1);
      expect(log.entries.filter((entry) => entry.level === 'error')).toEqual([1, 2].map(() => ({
        level: 'error', message: 'Executor producer listener failed', detail: {
          integrationId: 'test', bindingId: request.producerBinding.id, type: 'rows', reason: 'Synthetic listener failure',
        },
      })));
    } finally { await fixture.dispose(); }
  });

  test(`a listener that throws while a replacement session installs does not retire it (${dialer} dials)`, async () => {
    const { fixture, integration, publish } = await runningTurn(dialer);
    try {
      const delivered = deliveries(integration);
      const counter = workerSessions(fixture);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      integration.producers.subscribe(() => { throw new Error('Synthetic listener failure'); });
      for (const content of ['gap-0', 'gap-1', 'gap-2']) publish(row(content));
      await ready;
      await integration.execution.runningSessions();

      expect(delivered).toEqual(['rows:gap-0', 'rows:gap-1', 'rows:gap-2']);
      expect(counter.sessions).toBe(2);
    } finally { await fixture.dispose(); }
  });
}
