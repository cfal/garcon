import { expect, test } from 'bun:test';
import type { AgentAuthStatus, AgentReadiness } from '../../../common/agent-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('default-instance auth and endpoint readiness preserve their HTTP projections across restart', async () => {
  await withIntegrationFixture('provider-auth-defaults', async (fixture) => {
    const auth = await fixture.client.get<Record<string, AgentAuthStatus>>('/api/v1/agents/auth');
    const readiness = await fixture.client.get<Record<string, AgentReadiness>>('/api/v1/agents/readiness');
    for (const { agentId } of Object.values(fixture.directAgents)) {
      expect(auth[agentId]).toEqual({ authenticated: false, canReauth: false, label: '', source: 'none' });
      expect(readiness[agentId]).toEqual({ ready: true, nativeReady: false, endpointReady: true,
        reason: 'At least one compatible API provider endpoint is configured.',
      });
      const selected = await fixture.client.get<Record<string, AgentAuthStatus>>(
        `/api/v1/agents/auth?${new URLSearchParams({ agent: agentId })}`,
      );
      expect(selected).toEqual({ [agentId]: auth[agentId]! });
      await expect(fixture.client.post('/api/v1/agents/auth/login', { agentId })).rejects.toMatchObject({
        status: 400, body: { error: `Auth login is not supported for agent: ${agentId}` },
      });
    }
    expect(Object.keys(readiness)).toEqual(Object.keys(auth));
    await fixture.restartGarcon();
    const restoredAuth = await fixture.client.get<Record<string, AgentAuthStatus>>('/api/v1/agents/auth');
    const restoredReadiness = await fixture.client.get<Record<string, AgentReadiness>>('/api/v1/agents/readiness');
    expect(Object.keys(restoredAuth)).toEqual(Object.keys(auth));
    for (const { agentId } of Object.values(fixture.directAgents)) {
      expect(restoredAuth[agentId]).toEqual(auth[agentId]);
      expect(restoredReadiness[agentId]).toEqual(readiness[agentId]);
    }
  }, { bindAddress: '0.0.0.0', authentication: 'account' });
}, 30_000);
