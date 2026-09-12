import { expect, mock, test } from 'bun:test';
import { NodeProviderCapacity } from '../provider-capacity.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { AgentAuthLoginLaunchResult } from '../../../common/agent-auth.js';
import type { ProviderAuthService } from '../../execution-nodes/provider-auth.js';
import { NodeProviderAuthHost } from '../provider-auth-host.js';
import { NODE_WORKER_SERVICE_LIMITS } from '../worker/limits.js';

const instanceId = 'synthetic-instance';
const launched: AgentAuthLoginLaunchResult = { launched: true, alreadyRunning: false, sessionId: 'synthetic-login' };
const command = { method: 'provider-auth', instanceId, operation: 'launch-login' } as const;

function service(overrides: Partial<ProviderAuthService> = {}): ProviderAuthService {
  return { status: async () => null, loginStatus: async () => ({ state: 'idle', running: false }),
    launchLogin: async () => launched, completeLogin: async ({ sessionId }) => ({ submitted: true, sessionId }), ...overrides };
}

test('auth host rejects foreign and cancelled work before the provider sees it', async () => {
  const launch = mock(async () => launched);
  const host = new NodeProviderAuthHost(new NodeProviderCapacity(), instanceId, service({ launchLogin: launch }));
  expect(await host.execute({ ...command, instanceId: 'foreign' }, new AbortController().signal)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
  const reason = new Error('Synthetic pre-admission cancellation');
  await expect(host.execute(command, AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(launch).not.toHaveBeenCalled();
});

test('cancelled native login mutations retain capacity until their actual settlement', async () => {
  const pending = Promise.withResolvers<AgentAuthLoginLaunchResult>();
  const launch = mock(() => pending.promise);
  const host = new NodeProviderAuthHost(new NodeProviderCapacity(), instanceId, service({ launchLogin: launch }));
  const physical = new AbortController();
  const calls = Array.from({ length: NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests }, () => host.execute(command, physical.signal));
  const settled = Promise.allSettled(calls);
  const reason = new Error('Synthetic physical disconnect'); physical.abort(reason);
  expect(await host.execute(command, new AbortController().signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  expect(launch).toHaveBeenCalledTimes(NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests);
  pending.resolve(launched);
  expect(await settled).toEqual(calls.map(() => ({ status: 'rejected', reason })));
  expect(await host.execute(command, new AbortController().signal)).toEqual({ kind: 'provider-login-launched', instanceId, result: launched });
});

test('auth refusals preserve only definitive native codes while other mutation failures stay unknown', async () => {
  for (const code of ['OPERATION_UNSUPPORTED', 'AUTH_LOGIN_SESSION_MISMATCH', 'PROVIDER_FAILURE'] as const) {
    const host = new NodeProviderAuthHost(new NodeProviderCapacity(), instanceId, service({ launchLogin: async () => { throw new AgentIntegrationError(code, 'Synthetic private diagnostic', false); } }));
    expect(await host.execute(command, new AbortController().signal)).toEqual(code === 'PROVIDER_FAILURE'
      ? { kind: 'unknown' } : { kind: 'provider-auth-rejected', instanceId, code });
  }
});

test('auth polling drops cancelled evidence and keeps optional launch metadata valid', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<ProviderAuthService['status']>>>();
  const physical = new AbortController();
  const host = new NodeProviderAuthHost(new NodeProviderCapacity(), instanceId, service({ status: () => pending.promise,
    launchLogin: async () => ({ ...launched, deviceAuth: undefined }) }));
  const read = host.execute({ method: 'provider-auth', instanceId, operation: 'status' }, physical.signal);
  const reason = new Error('Synthetic status cancellation'); physical.abort(reason);
  pending.resolve({ authenticated: true, canReauth: true, label: 'Synthetic', source: 'cli' });
  await expect(read).rejects.toBe(reason);
  expect(await host.execute(command, new AbortController().signal)).toEqual({ kind: 'provider-login-launched', instanceId, result: launched });
});
