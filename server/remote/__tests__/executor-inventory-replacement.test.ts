import { TestWebSocketLink as WebSocketLink } from './test-session-transport.js';
import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { createNoiseServer, type NoiseSocketData } from '@cfal/noise-ws';
import type { AgentIntegration } from '@garcon/server-agent-interface';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { RemoteExecutorClient } from '../client/executor-client.js';

import { ProducerRelay } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';
import { integrationFixture, linkOptions } from './integration-fixture.js';
import { servePairedRuntime } from './runtime-adapter.js';
import { nextAvailability, replacementFixture } from './replacement-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test.each([
    ['ready', 'inventory'], ['ready', 'instance'], ['ready', 'runtime'],
    ['failed', 'inventory'], ['superseded', 'inventory'], ['ready', 'unchanged'],
  ] as const)(`remembers %s worker identity after A -> B -> A with %s (${dialer} dials)`, async (phase, change) => {
    let failure = Promise.withResolvers<void>();
    const f = replacementFixture(dialer, { logger: { debug() {}, info() {}, error() {}, warn(message) {
      if (message === 'Executor session setup failed') failure.resolve();
    } } });
    const original = integrationFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let originalRuntime = crypto.randomUUID();
    if (phase === 'failed') original.hooks.initialize = async () => { throw new Error('Synthetic failure'); };
    if (phase === 'superseded') original.hooks.initialize = async () => { entered.resolve(); await release.promise; };
    try {
      const installed = phase === 'ready' ? nextAvailability(f.client, 'ready')
        : phase === 'failed' ? failure.promise : entered.promise;
      await f.install(original.executor, originalRuntime);
      await installed;
      const first = f.client.generation;
      const replaced = nextAvailability(f.client, 'ready');
      await f.install(integrationFixture().executor);
      await replaced;
      const second = f.client.generation!;
      original.hooks.initialize = async () => {};
      release.resolve();
      if (change === 'inventory') original.integration.descriptor.label = 'Changed original';
      if (change === 'instance') Object.assign(original.scope, { instanceId: crypto.randomUUID() });
      if (change === 'runtime') originalRuntime = crypto.randomUUID();
      failure = Promise.withResolvers<void>();
      const returned = Promise.race([
        nextAvailability(f.client, 'ready').then(() => 'ready'),
        failure.promise.then(() => 'failed'),
      ]);
      await f.install(original.executor, originalRuntime);
      expect(await returned).toBe(change === 'unchanged' ? 'ready' : 'failed');
      if (change === 'unchanged') {
        expect(f.client.generation).not.toBe(first);
        expect(f.client.generation!.info.instanceId).toBe(original.scope.instanceId);
        expect(first!.token.retired).toBe(true);
        expect(f.errors).toEqual([]);
      } else {
        expect(f.client.availability).not.toBe('ready');
        expect(f.client.generation).toBe(second);
        expect(f.errors.at(-1)).toContain(change === 'inventory' ? 'changed within one worker' : 'identity disagree');
      }
    } finally { release.resolve(); await f.dispose(); }
  });

  test.each(['inventory', 'instance'])(`same-worker identity cannot change its %s (${dialer} dials)`, async change => {
    const failed = Promise.withResolvers<void>();
    const f = replacementFixture(dialer, { logger: { debug() {}, info() {}, error() {}, warn(message) {
      if (message === 'Executor session setup failed') failed.resolve();
    } } });
    const native = integrationFixture();
    try {
      const first = nextAvailability(f.client, 'ready');
      await f.install(native.executor);
      await first;
      const generation = f.client.generation!;
      if (change === 'inventory') native.integration.descriptor.label = 'Unexpected change';
      else Object.assign(native.scope, { instanceId: crypto.randomUUID() });
      f.controller.disconnect(); f.worker.disconnect();
      await failed.promise;
      expect(f.client.generation).toBe(generation);
      expect(f.client.availability).not.toBe('ready');
      expect(f.errors[0]).toContain(change === 'instance' ? 'identity disagree' : 'changed within one worker');
    } finally { await f.dispose(); }
  });

  test.each([1, 10_000])(`same-worker reconnect preserves facades and initialization after grace %i (${dialer} dials)`, async grace => {
    const f = replacementFixture(dialer, { reconnectGraceMs: grace });
    const native = integrationFixture();
    try {
      const first = nextAvailability(f.client, 'ready');
      await f.install(native.executor);
      await first;
      const generation = f.client.generation!;
      const integration = await generation.runtime.getAgentIntegration('test');
      const projects = await generation.runtime.getProjectService();
      const ready = nextAvailability(f.client, 'ready');
      f.controller.disconnect(); f.worker.disconnect();
      await ready;
      expect(f.client.generation).toBe(generation);
      expect(generation.token.retired).toBe(false);
      expect(f.client.runtime).toBe(generation.runtime);
      expect(await f.client.runtime.getAgentIntegration('test')).toBe(integration);
      expect(await f.client.runtime.getProjectService()).toBe(projects);
      expect(native.calls).toMatchObject({ migrate: 1, initialize: 1 });
    } finally { await f.dispose(); }
  });

  test(`replacement accepts changed descriptors, facets, schemas and empty inventory (${dialer} dials)`, async () => {
    const f = replacementFixture(dialer);
    try {
      let ready = nextAvailability(f.client, 'ready');
      await f.install(integrationFixture().executor);
      await ready;
      const previous = f.client.generation!;
      const old = await previous.runtime.getAgentIntegration('test');
      const saved = old.settings.defaults();
      const native = integrationFixture();
      const integration: AgentIntegration = {
        ...native.integration,
        descriptor: { ...native.integration.descriptor, label: 'Replacement' },
        settings: createVersionedSettings({ ownerId: 'test', schemaVersion: 2, defaults: { level: 3 }, descriptors: [
          { key: 'level', label: 'Level', type: 'number', min: 1, max: 5, step: 1 },
        ] }),
        singleQuery: null,
      };
      ready = nextAvailability(f.client, 'ready');
      await f.install({ ...native.executor, getAgentIntegration: async () => integration });
      await ready;
      const current = await f.client.runtime.getAgentIntegration('test');
      expect(current.descriptor.label).toBe('Replacement');
      expect(current.singleQuery).toBeNull();
      expect(current.settings.defaults()).toEqual({ ownerId: 'test', schemaVersion: 2, values: { level: 3 } });
      expect(() => current.settings.parse(saved)).toThrow();
      expect(saved).toEqual({ ownerId: 'test', schemaVersion: 1, values: {} });
      await expect(old.execution.runningSessions()).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      await previous.runtime.dispose();
      expect(f.client.availability).toBe('ready');
      const empty = integrationFixture();
      const info = await empty.executor.getInfo();
      ready = nextAvailability(f.client, 'ready');
      await f.install({ ...empty.executor, getInfo: async () => ({ ...info, integrationIds: [] }) });
      await ready;
      expect(f.client.generation!.integrations.size).toBe(0);
      expect((await f.client.runtime.getInfo()).integrationIds).toEqual([]);
      await expect(f.client.runtime.getAgentIntegration('test')).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
      expect(f.errors).toEqual([]);
    } finally { await f.dispose(); }
  });

  test(`every service facade belongs to its worker generation (${dialer} dials)`, async () => {
    const f = replacementFixture(dialer);
    const runtime = new ExecutionRuntime({ id: linkOptions.executorId, workspaceDir: homedir(), projectBasePath: homedir(),
      integrations: [], resolveCredential: async () => null,
    });
    try {
      const ready = nextAvailability(f.client, 'ready');
      await f.install(runtime);
      await ready;
      const previous = f.client.runtime;
      const files = await previous.getFilesService();
      const git = await previous.getGitService();
      const gh = await previous.getGhService();
      const terminals = await previous.getTerminalService();
      const projects = await previous.getProjectService();
      const replaced = nextAvailability(f.client, 'ready');
      await f.install(integrationFixture().executor);
      await replaced;
      const stale = { code: 'STALE_RESOURCE', outcome: 'not-dispatched' };
      await expect(files.identity({ path: '/synthetic' })).rejects.toMatchObject(stale);
      await expect(git.getStatus({ projectPath: '/synthetic' })).rejects.toMatchObject(stale);
      await expect(gh.getStatus()).rejects.toMatchObject(stale);
      await expect(terminals.list({ key: 'synthetic', expiresAtMs: null })).rejects.toMatchObject(stale);
      await expect(projects.inspect({ projectPath: '/synthetic' })).rejects.toMatchObject(stale);
      expect(f.client.generation!.runtime).not.toBe(previous);
    } finally { await f.dispose(); await runtime.dispose(); }
  });
}

test('a failed replacement cannot resurrect previously retired facades when the original worker returns', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const original = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const replacement = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const failed = Promise.withResolvers<void>();
  const client = new RemoteExecutorClient(linkOptions.executorId, controller, undefined, () => failed.resolve());
  const first = integrationFixture('/first');
  const second = integrationFixture('/second');
  second.hooks.initialize = async () => { throw new Error('Synthetic initialization failure'); };
  const cleanups: (() => void | Promise<void>)[] = [];
  for (const [link, native] of [[original, first], [replacement, second]] as const) {
    const relay = new ProducerRelay();
    const journal = new RpcReplyJournal();
    cleanups.push(() => { relay.dispose(); journal.dispose(); });
    link.onSession(transport => {
      const serving = servePairedRuntime(link, transport, native.executor, relay, journal);
      cleanups.push(() => serving.dispose());
    });
  }
  let selected = original;
  const noise = createNoiseServer();
  const server = Bun.serve<NoiseSocketData>({ hostname: '0.0.0.0', port: 0,
    fetch: (request, listener) => selected.upgrade(request, listener, noise), websocket: noise.websocket,
  });
  try {
    const ready = nextAvailability(client, 'ready');
    controller.dial(`ws://127.0.0.1:${server.port}/executor`);
    await ready;
    const previous = client.generation!;
    selected = replacement;
    controller.disconnect();
    await failed.promise;
    expect(previous.token.retired).toBe(true);
    expect(client.availability).toBe('offline');
    const restored = nextAvailability(client, 'ready');
    selected = original;
    await restored;
    expect(client.generation).not.toBe(previous);
    expect(client.generation!.info.instanceId).toBe(previous.info.instanceId);
    expect(previous.token.retired).toBe(true);
    await expect(previous.runtime.getProjectService()).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(first.calls).toMatchObject({ initialize: 2, migrate: 2 });
  } finally {
    await client.dispose(); await original.dispose(); await replacement.dispose();
    await noise.close(); await server.stop(true);
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});
