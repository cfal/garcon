import { expect, test } from 'bun:test';
import { AgentCallError, AgentIntegrationError } from '@garcon/server-agent-interface';
import { integrationFixture, requestFor } from '../../remote/__tests__/integration-fixture.js';
import { RuntimeMaintenance } from '../maintenance.js';

test('removal excludes new execution through the actual asynchronous removal lifetime', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const integration = guard.integration(f.integration);
  const request = await requestFor(integration);
  const held = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  let reserved = false;
  const removing = guard.remove([f.integration], () => { reserved = true; return () => { reserved = false; }; }, async () => {
    entered.resolve(); await held.promise;
  });
  await entered.promise;
  await expect(integration.execution.start(request)).rejects.toMatchObject({ outcome: 'not-dispatched' });
  expect(f.calls.start).toBe(0); expect(reserved).toBe(true);
  held.resolve(); await removing; expect(reserved).toBe(false);
  await integration.execution.start(request); expect(f.calls.start).toBe(1);
});

test('pending admission and existing native sessions each prevent removal', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const integration = guard.integration(f.integration);
  const request = await requestFor(integration);
  const held = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  f.hooks.start = async () => { entered.resolve(); await held.promise; };
  const starting = integration.execution.start(request); await entered.promise;
  let removed = false;
  const remove = () => guard.remove([f.integration], () => () => {}, async () => { removed = true; });
  await expect(remove()).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  held.resolve(); await starting;
  const running = { ...f.integration, execution: { ...f.integration.execution,
    async runningSessions() { return [{ agentSessionId: 'synthetic-session', status: null, startedAt: null }]; } } };
  await expect(guard.remove([running], () => () => {}, async () => { removed = true; })).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  expect(removed).toBe(false);
});

test('unknown native admission retains maintenance exclusion', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  f.hooks.query = async () => { throw new AgentCallError('unknown', 'Synthetic uncertainty'); };
  const integration = guard.integration(f.integration);
  await expect(integration.singleQuery!.run({ prompt: 'Synthetic', model: 'synthetic', thinkingMode: 'none',
    settings: f.integration.settings.defaults(), endpoint: null, signal: new AbortController().signal })).rejects.toThrow();
  await expect(guard.remove([f.integration], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test('Stop with empty logical inventory cannot establish native retirement', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const integration = guard.integration(f.integration);
  await integration.execution.abort(await integration.execution.start(await requestFor(integration)));
  expect(await integration.execution.runningSessions()).toEqual([]);
  await expect(guard.remove([f.integration], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test('structured unknown steering retains exclusion without changing the result', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const result = { kind: 'failed' as const, outcome: 'unknown' as const, message: 'Synthetic delivery uncertainty' };
  const source = { ...f.integration, steering: { async captureTarget() { return null; }, async steer() { return result; } } };
  const integration = guard.integration(source);
  expect(await integration.steering!.steer({ chatId: 'synthetic', projectPath: '/synthetic', agentSessionId: 'synthetic',
    nativeSession: null, target: null, input: 'Synthetic', clientMessageId: 'synthetic' })).toEqual(result);
  await expect(guard.remove([source], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test.each(['throw', 'abort'] as const)('pre-removal inventory %s is a definite refusal, never uncertainty', async fault => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance(); const abort = new AbortController();
  let removed = false; let reserved = false;
  const source = { ...f.integration, execution: { ...f.integration.execution, async runningSessions() {
    if (fault === 'throw') throw new Error('Synthetic inventory failure');
    abort.abort(); return new Promise<never>(() => {});
  } } };
  await expect(guard.remove([source], () => { reserved = true; return () => { reserved = false; }; },
    async () => { removed = true; }, abort.signal)).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  expect(removed).toBe(false); expect(reserved).toBe(false);
  await guard.remove([], () => () => {}, async () => { removed = true; });
  expect(removed).toBe(true);
});

test('accepted resume remains excluded after handle delivery until its producer terminal', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const integration = guard.integration(f.integration);
  const request = { ...await requestFor(integration), agentSessionId: 'test-session', nativeSession: null };
  await integration.execution.resume(request);
  expect(await integration.execution.runningSessions()).toEqual([]);
  await expect(guard.remove([f.integration], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  f.nativePublishers[0]!({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
  let removed = false;
  await guard.remove([f.integration], () => () => {}, async () => { removed = true; });
  expect(removed).toBe(true);
});

test('producer close cannot establish native exit even if its logical inventory is empty', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance(); const integration = guard.integration(f.integration);
  const request = await requestFor(integration);
  await integration.execution.start(request);
  await integration.producers.close(request.producerBinding);
  expect(f.calls.abort).toBe(1);
  await expect(guard.remove([f.integration], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test.each(['TIMEOUT', 'UNAVAILABLE'] as const)('single-query %s does not mistake its raced failure for native exit', async code => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  f.hooks.query = async () => { throw new AgentIntegrationError(code, 'Synthetic cancellation while native teardown remains pending', false); };
  const integration = guard.integration(f.integration);
  await expect(integration.singleQuery!.run({ prompt: 'Synthetic', model: 'synthetic', thinkingMode: 'none',
    settings: integration.settings.defaults(), endpoint: null, signal: new AbortController().signal })).rejects.toMatchObject({ code });
  await expect(guard.remove([f.integration], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test('definitely rejected admissions do not latch uncertainty', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance(); const integration = guard.integration(f.integration);
  f.hooks.start = async () => { throw new AgentCallError('not-dispatched', 'Synthetic refusal'); };
  await expect(integration.execution.start(await requestFor(integration))).rejects.toThrow();
  await guard.remove([f.integration], () => () => {}, async () => {});
});

test('uncertainty appearing during the inventory sweep refuses removal', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance(); const integration = guard.integration(f.integration);
  const inventory = { ...f.integration, execution: { ...f.integration.execution, async runningSessions() {
    await integration.lifecycle.stop(); return [];
  } } };
  let removed = false;
  await expect(guard.remove([inventory], () => () => {}, async () => { removed = true; })).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
  expect(removed).toBe(false);
});

test('native session release cannot establish quiescence', async () => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const integration = guard.integration({ ...f.integration, nativeSessions: {
    async resolveNativeSession() { return null; }, async describeSource() { return null; }, async release() {},
  } });
  await integration.nativeSessions!.release({ chat: { chatId: 'synthetic', agentSessionId: null,
    projectPath: '/synthetic', nativeSession: null }, reason: 'deleted', signal: new AbortController().signal });
  await expect(guard.remove([integration], () => () => {}, async () => {})).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test.each(['provider-error', 'not-dispatched'] as const)('generic facet admission preserves definite versus uncertain %s', async outcome => {
  const f = integrationFixture(); const guard = new RuntimeMaintenance();
  const integration = guard.integration({ ...f.integration, steering: {
    async captureTarget() { return null; }, async steer() {
      if (outcome === 'not-dispatched') throw new AgentCallError('not-dispatched', 'Synthetic refusal');
      throw new AgentIntegrationError('PROVIDER_FAILURE', 'Synthetic unconfirmed effect', false);
    },
  } });
  await expect(integration.steering!.steer({ chatId: 'synthetic', projectPath: '/synthetic', agentSessionId: 'synthetic',
    nativeSession: null, target: null, input: 'Synthetic', clientMessageId: 'synthetic' })).rejects.toThrow();
  const removal = guard.remove([integration], () => () => {}, async () => {});
  if (outcome === 'not-dispatched') await removal;
  else await expect(removal).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
});

test.each(['provider-failure', 'command-exit', 'missing-exit', 'unknown-command'] as const)(
  'failed terminal retains native teardown exclusion except for confirmed command exit: %s', async failure => {
    const f = integrationFixture(); const guard = new RuntimeMaintenance();
    const integration = guard.integration(f.integration);
    const request = await requestFor(integration);
    await integration.execution.start(request);
    f.nativePublishers[0]!({ type: 'run-ended', runId: request.runId, outcome: 'failed',
      error: { code: failure === 'unknown-command' ? 'OUTCOME_UNKNOWN' : 'PROVIDER_FAILURE' },
      commandOutcome: failure === 'provider-failure' ? null : { outcome: 'failed',
        exitCode: failure === 'missing-exit' ? null : 1, signal: null, capture: 'complete',
        cwd: { kind: 'reported', path: '/synthetic' } } });
    expect(await integration.execution.runningSessions()).toEqual([]);
    let removed = false;
    const removal = guard.remove([integration], () => () => {}, async () => { removed = true; });
    if (failure === 'command-exit') await removal;
    else await expect(removal).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    expect(removed).toBe(failure === 'command-exit');
  },
);
