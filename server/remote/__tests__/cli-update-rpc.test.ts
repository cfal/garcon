import { expect, test } from 'bun:test';
import { AgentCallError, AgentIntegrationError, type AgentCliUpdateStatusRequest } from '@garcon/server-agent-interface';
import type { AgentCliUpdateStatus } from '@garcon/common/agent-cli-update';
import { rpcContinuity } from '../transport/rpc-protocol.js';
import { rpcLane } from '../transport/rpc-routing.js';
import { remoteFixture } from './integration-fixture.js';

const BEHIND: AgentCliUpdateStatus = {
  installMethod: 'npm',
  installPath: '/opt/synthetic/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  currentVersion: '2.1.238',
  latestVersion: '2.1.300',
  advisory: 'behind-latest',
  updateCommand: 'npm install -g --prefix /opt/synthetic --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest',
  canUpdate: true,
  message: null,
  checkedAt: '2026-11-20T00:00:00.000Z',
  run: { state: 'idle', startedAt: null, finishedAt: null, message: null, output: null },
};

const RUNNING: AgentCliUpdateStatus = {
  ...BEHIND,
  run: { state: 'running', startedAt: '2026-11-20T00:00:01.000Z', finishedAt: null, message: 'Checking for the latest version', output: null },
};

test('CLI update calls are journaled on the primary lane', () => {
  expect(rpcContinuity('cliUpdates.status')).toBe('journaled');
  expect(rpcContinuity('cliUpdates.startUpdate')).toBe('journaled');
  expect(rpcLane('cliUpdates.status', { refresh: false })).toBe('primary');
  expect(rpcLane('cliUpdates.startUpdate', null)).toBe('primary');
});

for (const dialer of ['controller', 'worker'] as const) {
  test(`CLI update status and starts cross the executor link (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const received: AgentCliUpdateStatusRequest[] = [];
      const hooks = fixture.generations[0]!.hooks;
      hooks.cliStatus = async (request) => {
        received.push(request);
        return BEHIND;
      };
      hooks.cliUpdate = async () => RUNNING;
      const integration = await fixture.executor.getAgentIntegration('test');
      expect(integration.cliUpdates).not.toBeNull();
      expect(await integration.cliUpdates!.status({ refresh: true, signal: new AbortController().signal })).toEqual(BEHIND);
      expect(received).toHaveLength(1);
      expect(received[0]!.refresh).toBe(true);
      expect(received[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(await integration.cliUpdates!.startUpdate()).toEqual(RUNNING);
      expect(fixture.generations[0]!.calls.cliUpdate).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  test(`the controller rejects a malformed CLI update status (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      fixture.generations[0]!.hooks.cliStatus = async () => ({ ...BEHIND, advisory: 'stale' } as unknown as AgentCliUpdateStatus);
      const integration = await fixture.executor.getAgentIntegration('test');
      const failure = await integration.cliUpdates!.status({ refresh: false }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentIntegrationError);
      expect((failure as AgentIntegrationError).code).toBe('PROVIDER_FAILURE');
    } finally {
      await fixture.dispose();
    }
  });

  test(`an unsupported update keeps its error code across the link (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      fixture.generations[0]!.hooks.cliUpdate = async () => {
        throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Update it with the tool that installed it.', false);
      };
      const integration = await fixture.executor.getAgentIntegration('test');
      const failure = await integration.cliUpdates!.startUpdate().catch((error: unknown) => error);
      expect(failure instanceof AgentIntegrationError || failure instanceof AgentCallError).toBe(true);
      expect((failure as { code?: string }).code).toBe('OPERATION_UNSUPPORTED');
      expect((failure as Error).message).toContain('Update it with the tool that installed it.');
    } finally {
      await fixture.dispose();
    }
  });
}
