import { expect, spyOn, test } from 'bun:test';
import type { AgentInstallation } from '@garcon/server-agent-interface';
import { AGENT_CLI_UPDATE_ACQUIRE_TIMEOUT_MS, AGENT_CLI_UPDATE_RPC_TIMEOUT_MS } from '@garcon/common/agent-installation';
import { outgoingFault, remoteFixture } from './integration-fixture.js';
import { rpcContinuity } from '../transport/rpc-protocol.js';
import { rpcLane } from '../transport/rpc-routing.js';
import { ExecutorRpc } from '../transport/rpc.js';
import type { RemoteExecutorClient } from '../client/executor-client.js';

const installed = { version: '2.1.285', minimumVersion: '2.1.238', supported: true };

function nextAvailability(executor: RemoteExecutorClient, expected: 'ready' | 'reconnecting'): Promise<void> {
  return new Promise((resolve) => {
    const off = executor.onAvailabilityChanged((value) => { if (value === expected) { off(); resolve(); } });
  });
}

function holdInstallation(fixture: Awaited<ReturnType<typeof remoteFixture>>) {
  const worker = fixture.generations[0]!;
  const released = Promise.withResolvers<void>();
  const getInfo = worker.executor.getInfo;
  worker.executor.getInfo = async () => {
    await released.promise;
    return getInfo();
  };
  return () => { worker.executor.getInfo = getInfo; released.resolve(); };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`installation maintenance executes on the selected worker (${dialer} dials)`, async () => {
    const calls: string[] = [];
    let version = '2.1.207';
    const installation = {
      async status() { calls.push('status'); return { version, minimumVersion: '2.1.238', supported: version === '2.1.285' }; },
      async update() {
        calls.push('update');
        version = '2.1.285';
        return { installation: await this.status(), output: 'Synthetic update complete' };
      },
    } satisfies AgentInstallation;
    const fixture = await remoteFixture(dialer, (_controller, _worker, runtime) => {
      Object.assign(runtime.integration, { installation });
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      expect(integration.installation).not.toBeNull();
      await expect(integration.installation!.status()).resolves.toMatchObject({ version: '2.1.207', supported: false });
      await expect(integration.installation!.update({ timeoutMs: AGENT_CLI_UPDATE_RPC_TIMEOUT_MS, expectedScope: integration.producers.scope })).resolves.toMatchObject({
        installation: { version: '2.1.285', supported: true }, output: 'Synthetic update complete',
      });
      expect(calls).toEqual(['status', 'update', 'status']);
    } finally { await fixture.dispose(); }
  });

  test(`a reconnect wait preserves the updater's full RPC budget (${dialer} dials)`, async () => {
    let updates = 0;
    const fixture = await remoteFixture(dialer, (_controller, _worker, runtime) => {
      Object.assign(runtime.integration, { installation: {
        async status() { return installed; },
        async update() { updates++; return { installation: installed, output: 'Updated after acquisition' }; },
      } satisfies AgentInstallation });
    });
    const calls = spyOn(ExecutorRpc.prototype, 'call');
    const now = performance.now.bind(performance);
    const clock = spyOn(performance, 'now');
    const release = holdInstallation(fixture);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const updated = integration.installation!.update({ expectedScope: { ...integration.producers.scope } });
      clock.mockImplementation(() => now() + AGENT_CLI_UPDATE_ACQUIRE_TIMEOUT_MS - 3_000);
      release();
      await expect(updated).resolves.toMatchObject({ output: 'Updated after acquisition' });
      const sent = calls.mock.calls.filter(([, method]) => method === 'installation.update');
      expect(sent).toHaveLength(1);
      expect(sent[0]![3]?.timeoutMs).toBe(AGENT_CLI_UPDATE_RPC_TIMEOUT_MS);
      expect(sent[0]![3]?.dispatchDeadline).toBeUndefined();
      expect(updates).toBe(1);
    } finally { clock.mockRestore(); calls.mockRestore(); release(); await fixture.dispose(); }
  });

  test(`an expired acquisition never dispatches an updater (${dialer} dials)`, async () => {
    let updates = 0;
    const fixture = await remoteFixture(dialer, (_controller, _worker, runtime) => {
      Object.assign(runtime.integration, { installation: {
        async status() { return installed; },
        async update() { updates++; return { installation: installed, output: '' }; },
      } satisfies AgentInstallation });
    });
    const now = performance.now.bind(performance);
    const clock = spyOn(performance, 'now');
    const release = holdInstallation(fixture);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const updated = integration.installation!.update({ expectedScope: { ...integration.producers.scope } }).catch((error: unknown) => error);
      clock.mockImplementation(() => now() + AGENT_CLI_UPDATE_ACQUIRE_TIMEOUT_MS + 1_000);
      release();
      expect(await updated).toMatchObject({ outcome: 'not-dispatched' });
      expect(updates).toBe(0);
    } finally { clock.mockRestore(); release(); await fixture.dispose(); }
  });

  for (const replacementTiming of ['before-admission', 'during-acquisition']) {
    test(`a worker replaced ${replacementTiming} receives no updater (${dialer} dials)`, async () => {
      let originalUpdates = 0;
      let replacementUpdates = 0;
      const fixture = await remoteFixture(dialer, (_controller, _worker, runtime) => {
        Object.assign(runtime.integration, { installation: {
          async status() { return installed; },
          async update() { originalUpdates++; return { installation: installed, output: '' }; },
        } satisfies AgentInstallation });
      });
      const release = holdInstallation(fixture);
      try {
        const integration = await fixture.executor.getAgentIntegration('test');
        const expectedScope = { ...integration.producers.scope };
        const runtime = fixture.generations[0]!;
        Object.assign(runtime.scope, { instanceId: crypto.randomUUID() });
        Object.assign(runtime.integration, { installation: {
          async status() { return installed; },
          async update() { replacementUpdates++; return { installation: installed, output: '' }; },
        } satisfies AgentInstallation });
        const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
        fixture.controller.disconnect();
        await reconnecting;
        const ready = nextAvailability(fixture.executor, 'ready');
        if (replacementTiming === 'before-admission') {
          release();
          await ready;
          await expect(integration.installation!.update({ expectedScope })).rejects.toMatchObject({ code: 'STALE_RESOURCE', outcome: 'not-dispatched' });
        } else {
          const updated = integration.installation!.update({ expectedScope }).catch((error: unknown) => error);
          release();
          await ready;
          expect(await updated).toMatchObject({ outcome: 'not-dispatched' });
        }
        expect(originalUpdates).toBe(0);
        expect(replacementUpdates).toBe(0);
      } finally { release(); await fixture.dispose(); }
    });
  }

  for (const lost of ['request', 'reply'] as const) {
    test(`an update lost at its ${lost} completes once after reconnect (${dialer} dials)`, async () => {
      let updates = 0;
      let fault!: ReturnType<typeof outgoingFault>;
      const status = { version: '2.1.285', minimumVersion: '2.1.238', supported: true };
      const installation = {
        async status() { return status; },
        async update() { updates++; return { installation: status, output: 'Synthetic journaled installation result' }; },
      } satisfies AgentInstallation;
      const fixture = await remoteFixture(dialer, (controller, worker, runtime) => {
        Object.assign(runtime.integration, { installation });
        fault = outgoingFault(lost === 'request' ? controller : worker);
      });
      try {
        const integration = await fixture.executor.getAgentIntegration('test');
        fault.inject = (encoded) => {
          const matches = lost === 'request'
            ? encoded.includes('"method":"installation.update"')
            : encoded.includes('Synthetic journaled installation result');
          if (!matches) return null;
          fault.inject = () => null;
          return 'disconnect';
        };
        await expect(integration.installation!.update({ timeoutMs: 5000, expectedScope: integration.producers.scope })).resolves.toEqual({ installation: status, output: 'Synthetic journaled installation result' });
        expect(updates).toBe(1);
      } finally { await fixture.dispose(); }
    });
  }
}

test('installation maintenance uses journaled primary RPCs', () => {
  for (const method of ['installation.status', 'installation.update']) {
    expect(rpcContinuity(method)).toBe('journaled');
    expect(rpcLane(method, null)).toBe('primary');
  }
});
