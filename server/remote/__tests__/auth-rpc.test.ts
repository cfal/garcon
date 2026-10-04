import { expect, test } from 'bun:test';
import type { AgentAuthLoginStatus } from '@garcon/common/agent-auth';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { integrationFixture } from './integration-fixture.js';
import { RUNTIME_BACKENDS, runtimeAdapter } from './runtime-adapter.js';

for (const backend of RUNTIME_BACKENDS) {
  test(`auth login status and validation errors survive ${backend} transport`, async () => {
    const fixture = integrationFixture();
    let status: AgentAuthLoginStatus = {
      state: 'running', running: true, sessionId: 'synthetic-session', completionPending: false,
      deviceAuth: { url: 'https://auth.example/login', needsCode: true },
      retryableError: 'Copy the complete authorization code.',
    };
    const integration = {
      ...fixture.integration,
      auth: {
        status: async () => ({ authenticated: false, canReauth: true, label: '' }),
        loginStatus: async (expectedSessionId?: string) => {
          expect(expectedSessionId).toBe('synthetic-session');
          return status;
        },
        completeLogin: async (sessionId: string, code: string) => {
          expect(sessionId).toBe('synthetic-session');
          if (!code.includes('#')) throw new AgentIntegrationError('AUTH_LOGIN_CODE_INVALID', 'Copy the complete authorization code.', true);
          status = { state: 'running', running: true, sessionId, completionPending: true };
          return { submitted: true as const, sessionId };
        },
      },
    };
    const adapter = await runtimeAdapter({ ...fixture.executor, getAgentIntegration: async () => integration }, backend);
    try {
      const remote = await adapter.executor.getAgentIntegration('test');
      expect(await remote.auth!.loginStatus!('synthetic-session')).toEqual(status);
      await expect(remote.auth!.completeLogin!('synthetic-session', 'partial')).rejects.toMatchObject({ code: 'AUTH_LOGIN_CODE_INVALID', retryable: true });
      expect(await remote.auth!.completeLogin!('synthetic-session', 'complete#suffix')).toEqual({ submitted: true, sessionId: 'synthetic-session' });
      expect(await remote.auth!.loginStatus!('synthetic-session')).toEqual({ state: 'running', running: true, sessionId: 'synthetic-session', completionPending: true });
    } finally {
      await adapter.dispose();
      await fixture.executor.dispose();
    }
  });
}
