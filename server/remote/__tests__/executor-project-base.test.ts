import { expect, spyOn, test } from 'bun:test';
import type { AgentIntegration } from '@garcon/server-agent-interface';
import { RemoteAgentIntegration } from '../client/remote-agent-integration.js';
import { integrationFixture } from './integration-fixture.js';
import { nextAvailability, replacementFixture } from './replacement-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test.each([false, true])(`worker replacement refreshes project base and execution policy (${dialer} dials, literal=%s)`, async literal => {
    const f = replacementFixture(dialer);
    let release = Promise.withResolvers<void>();
    release.resolve();
    try {
      const ready = nextAvailability(f.client, 'ready');
      await f.install(integrationFixture('/workspace').executor);
      await ready;
      for (const base of ['/', '/workspace/narrow']) {
        const previous = f.client.generation!;
        const integration = await previous.runtime.getAgentIntegration('test');
        const projects = await previous.runtime.getProjectService();
        const native = integrationFixture(base);
        const entered = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        native.hooks.initialize = async () => { entered.resolve(); await release.promise; };
        const replacement: AgentIntegration = literal
          ? { ...native.integration, literalExecution: { selectionLabel: 'Runtime', inputFormatByModel: {} }, singleQuery: null }
          : native.integration;
        const replaced = nextAvailability(f.client, 'ready');
        await f.install({ ...native.executor, getAgentIntegration: async () => replacement });
        await entered.promise;
        expect(f.client.availability).toBe('offline');
        expect(f.client.generation).toBe(previous);
        expect(previous.token.retired).toBe(true);
        await expect(previous.runtime.getInfo()).rejects.toMatchObject({ code: 'STALE_RESOURCE', outcome: 'not-dispatched' });
        await expect(projects.inspect({ projectPath: base })).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
        release.resolve();
        await replaced;
        const current = f.client.runtime;
        expect((await current.getInfo()).projectBasePath).toBe(base);
        expect((await current.getInfo()).instanceId).not.toBe(previous.info.instanceId);
        expect(await current.getAgentIntegration('test')).not.toBe(integration);
        expect((await current.getAgentIntegration('test')).literalExecution).toEqual(replacement.literalExecution);
        expect(await current.getProjectService()).not.toBe(projects);
        expect(native.calls).toMatchObject({ migrate: 1, initialize: 1 });
      }
      expect(f.errors).toEqual([]);
    } finally { release.resolve(); await f.dispose(); }
  });
}

test('a superseded candidate cannot publish metadata or errors over the accepted session', async () => {
  const f = replacementFixture('controller');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const initialize = RemoteAgentIntegration.prototype.initialize;
  const initialization = spyOn(RemoteAgentIntegration.prototype, 'initialize')
    .mockImplementation(async function (this: RemoteAgentIntegration, backing, assertCurrent) {
      await initialize.call(this, backing, assertCurrent);
      if (backing.info.projectBasePath === '/stale') {
        entered.resolve();
        await release.promise;
        finished.resolve();
      }
    });
  try {
    const ready = nextAvailability(f.client, 'ready');
    await f.install(integrationFixture('/stale').executor);
    await entered.promise;
    await f.install(integrationFixture('/accepted').executor);
    await ready;
    release.resolve();
    await finished.promise;
    expect((await f.client.runtime.getInfo()).projectBasePath).toBe('/accepted');
    expect(f.errors).toEqual([]);
  } finally { release.resolve(); initialization.mockRestore(); await f.dispose(); }
});
