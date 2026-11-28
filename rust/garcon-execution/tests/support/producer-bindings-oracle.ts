import type { AgentIntegration } from '@garcon/server-agent-interface';
import { ExecutorSessionLostError } from '../../../../server/common/executor-disconnect.ts';
import { ProducerBindings } from '../../../../server/controller/agents/producer-bindings.ts';
import { createProducerFixture } from '../../../../server/controller/agents/__tests__/producer-fixture.ts';
import { ProducerLease } from '../../../../server/controller/ledger/producer-lease.ts';
import { LedgerFencedError } from '../../../../server/controller/ledger/errors.ts';

function errorResult(error: unknown) {
  const typed = error as Error & { outcome?: string };
  return { error: typed.message, outcome: typed.outcome ?? null };
}

export async function producerBindingsTrace(scenario: string) {
  const fixture = createProducerFixture();
  const registering = Promise.withResolvers<void>();
  const workerClose = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const errors: unknown[] = [];
  const result: unknown[] = [];
  let reconnecting = false;
  let scopes = 0;
  let subscriptions = 0;
  let attempt = 0;
  const integration = {
    descriptor: {
      id: 'test', label: 'Test', icon: null, supportedPermissionModes: [], supportedThinkingModes: [],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [],
    },
    execution: {
      start: async () => fixture.reference('execution'), resume: async () => fixture.reference('execution'),
      abort: async () => false, runningSessions: async () => [],
    },
    catalog: {
      snapshot: async () => ({ models: [], defaultModel: '', requiresStrictModelDiscovery: false, generation: null }),
    },
    settings: {
      describe: () => [], defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }),
      parse: input => input, migrate: async input => input, applyPatch: current => current,
    },
    lifecycle: { start: async () => {}, stop: async () => {}, migrateOwnedStorage: async () => {} },
    migration: {
      translateLegacyModel: async ({ model }) => model, translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    permissions: { respond: async () => {} },
    attachments: null, literalExecution: null, readiness: null, auth: null, commands: null,
    compaction: null, forking: null, steering: null, endpoints: null, singleQuery: null,
    legacyHistoryImport: null, nativeHistoryImport: null, nativeActivity: null, nativeSessions: null,
    configurationValidation: null, sessionConfiguration: null, projectPathUpdates: null,
    usageHistory: null, cliUpdates: null,
    producers: {
      ...fixture.producers,
      get scope() {
        scopes++;
        if (reconnecting) throw new Error('Executor is reconnecting');
        return fixture.producers.scope;
      },
      subscribe(...args: Parameters<typeof fixture.producers.subscribe>) {
        subscriptions++;
        return fixture.producers.subscribe(...args);
      },
      async bind(...args: Parameters<typeof fixture.producers.bind>) {
        const [request] = args;
        calls.push(['bind', request.chatId]);
        attempt++;
        if (scenario === 'retry' && attempt < 3) {
          throw new ExecutorSessionLostError('not-dispatched', 'session lost');
        }
        if (scenario === 'close-during-bind' || scenario === 'join-cancel') await registering.promise;
        await fixture.producers.bind(...args);
      },
      async close(...args: Parameters<typeof fixture.producers.close>) {
        calls.push(['close']);
        if (scenario === 'close-during-bind' || scenario === 'replace-while-closing') await workerClose.promise;
        await fixture.producers.close(...args);
      },
    },
  } satisfies AgentIntegration;
  const bindings = new ProducerBindings(
    error => errors.push(errorResult(error)),
    (chat, lease, error) => {
      calls.push(['failure', chat, lease.closed, error]);
      throw new Error('Synthetic terminal failure');
    },
    (chat, lease) => calls.push(['gap', chat, lease.closed]),
    (chat, lease, agent, event) => calls.push(['launch', chat, lease.closed, agent, event]),
    (chat, lease, run) => calls.push(['steerable', chat, lease.closed, run]),
  );
  const lease = (label: string) => new ProducerLease(event => {
    if (label === 'fenced') throw new LedgerFencedError('fenced-chat');
    calls.push(['publish', label, event]);
  }, () => calls.push(['lease-closed', label]));
  const emitRows = (binding: Awaited<ReturnType<ProducerBindings['bind']>>) => fixture.emit(binding, { type: 'rows', rows: [] });
  const outcome = (pending: Promise<Awaited<ReturnType<ProducerBindings['bind']>>>) => pending.then(
    binding => ({ kind: binding.kind }), errorResult,
  );

  switch (scenario) {
    case 'dedup':
      for (let index = 0; index < 3; index++) {
        const current = lease('chat');
        const binding = await bindings.bind(integration, 'chat', current);
        result.push(binding === await bindings.bind(integration, 'chat', current));
        current.close();
      }
      break;
    case 'publication-failed':
    case 'sink-error': {
      const bad = lease(scenario === 'sink-error' ? 'fenced' : 'failed');
      const good = lease('healthy');
      const binding = await bindings.bind(integration, 'bad', bad);
      const other = await bindings.bind(integration, 'healthy', good);
      if (scenario === 'publication-failed') fixture.emit(binding, {
        type: 'publication-failed', error: { code: 'OUTCOME_UNKNOWN', message: 'Synthetic publication failure' },
      });
      emitRows(binding);
      emitRows(other);
      result.push(bad.closed, good.closed);
      bad.close();
      good.close();
      break;
    }
    case 'scope-unavailable': {
      const current = lease('chat');
      const binding = await bindings.bind(integration, 'chat', current);
      reconnecting = true;
      emitRows(binding);
      emitRows({ ...binding, instanceId: 'another-instance' });
      emitRows({ ...binding, executorId: 'another-executor' });
      emitRows({ ...binding, integrationId: 'another-agent' });
      emitRows({ ...binding, id: 'another-binding' });
      const other = lease('offline');
      result.push(await outcome(bindings.bind(integration, 'offline', other)));
      current.close();
      break;
    }
    case 'close-during-bind': {
      const current = lease('chat');
      const first = outcome(bindings.bind(integration, 'chat', current));
      const second = outcome(bindings.bind(integration, 'chat', current));
      current.close();
      registering.resolve();
      result.push(await first, await second, await outcome(bindings.bind(integration, 'chat', current)));
      workerClose.resolve();
      break;
    }
    case 'replace-while-closing': {
      const old = lease('old');
      const previous = await bindings.bind(integration, 'chat', old);
      old.close();
      const current = lease('new');
      const next = await bindings.bind(integration, 'chat', current);
      emitRows(previous);
      emitRows(next);
      result.push(await outcome(bindings.bind(integration, 'chat', old)));
      current.close();
      workerClose.resolve();
      break;
    }
    case 'control-events': {
      const current = lease('chat');
      const binding = await bindings.bind(integration, 'chat', current);
      bindings.onStarted('run', () => { calls.push(['started']); return Promise.reject(new Error('Synthetic start failure')); });
      result.push(bindings.hasStarted('run'));
      fixture.emit(binding, { type: 'started', runId: 'run' });
      fixture.emit(binding, { type: 'started', runId: 'run' });
      result.push(bindings.hasStarted('run'));
      fixture.emit(binding, { type: 'steerable', runId: 'run' });
      fixture.emit(binding, { type: 'publication-gap' });
      fixture.emit(binding, { type: 'launch-settled', runId: 'run', error: { code: 'OUTCOME_UNKNOWN' } });
      fixture.emit(binding, { type: 'run-ended', runId: 'run', outcome: 'interrupted' });
      result.push(bindings.hasStarted('run'));
      current.close();
      break;
    }
    case 'join-cancel': {
      const current = lease('chat');
      const first = outcome(bindings.bind(integration, 'chat', current));
      result.push(await outcome(bindings.bind(integration, 'chat', current, { dispatchDeadline: performance.now() + 10 })));
      const stop = new AbortController();
      const stopped = outcome(bindings.bind(integration, 'chat', current, { signal: stop.signal }));
      stop.abort(new Error('Synthetic stop'));
      result.push(await stopped);
      registering.resolve();
      result.push(await first);
      current.close();
      break;
    }
    case 'retry': {
      const current = lease('chat');
      result.push(await outcome(bindings.bind(integration, 'chat', current)));
      current.close();
      break;
    }
    default:
      throw new Error(`Unknown producer bindings scenario: ${scenario}`);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  return { result, calls, errors, scopes, subscriptions };
}
