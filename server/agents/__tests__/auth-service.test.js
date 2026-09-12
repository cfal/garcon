import { afterEach, expect, mock, test } from 'bun:test';
import { AgentAuthService } from '../auth-service.js';
import { createProviderAuthFixture } from './provider-auth-fixture.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture() {
  const f = await createProviderAuthFixture();
  fixtures.push(f);
  /** @satisfies {import('../auth-service.js').AgentAuthServiceOptions['instances']} */
  const instances = {
    defaultFor: (nodeId, agentId) => f.instances.defaultFor(nodeId, agentId),
    metadataForInstance: (ref) => f.instances.metadataForInstance(ref),
    authForInstance: (ref) => f.instances.authForInstance(ref),
  };
  const hasEndpointModels = mock(() => false);
  const service = new AgentAuthService({ instances, localNodeId: 'local-node', defaultAgentIds: ['test'], hasEndpointModels });
  return { ...f, service, hasEndpointModels, authInstances: instances };
}

test('projects only the configured local default auth and login owner', async () => {
  const f = await fixture();
  f.primary.integration.auth.completeLogin = undefined;
  expect(f.service.supportsLogin('test')).toBe(true);
  expect(f.service.supportsLoginCompletion('test')).toBe(false);
  const signal = new AbortController().signal;
  expect(await f.service.status('test', signal)).toMatchObject({ label: 'primary' });
  expect(await f.service.statusMap(signal)).toEqual({ test: {
    authenticated: true, canReauth: true, label: 'primary', source: 'cli',
  } });
  const launch = await f.service.launchLogin('test');
  expect(await f.service.loginStatus('test', launch.sessionId, signal)).toMatchObject({
    deviceAuth: { url: 'https://primary.example.test/login' },
  });
  await expect(f.service.completeLogin('test', launch.sessionId, 'synthetic-code'))
    .rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
  for (const operation of Object.values(f.secondary.integration.auth)) expect(operation).not.toHaveBeenCalled();
});

test('separates native and controller-owned endpoint readiness without consulting another profile', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  expect(await f.service.readinessMap(undefined, signal)).toEqual({ test: {
    ready: true, nativeReady: true, endpointReady: false, reason: 'Native agent authentication is available.',
  } });
  const endpoint = await fixture();
  endpoint.primary.integration.auth = null;
  endpoint.primary.integration.endpoints = { validate: async () => {} };
  endpoint.hasEndpointModels.mockReturnValue(true);
  expect(await endpoint.service.readinessMap(undefined, signal)).toEqual({ test: {
    ready: true, nativeReady: false, endpointReady: true,
    reason: 'At least one compatible API provider endpoint is configured.',
  } });
  expect(await endpoint.service.statusMap(signal)).toEqual({ test: {
    authenticated: false, canReauth: false, label: 'Synthetic provider', source: 'none',
  } });
  expect(f.secondary.integration.auth.status).not.toHaveBeenCalled();
  expect(endpoint.secondary.integration.auth.status).not.toHaveBeenCalled();
});

test('reuses supplied default auth evidence without launching another auth read', async () => {
  const f = await fixture();
  expect(await f.service.readinessMap({ test: { authenticated: true } }, new AbortController().signal))
    .toMatchObject({ test: { ready: true, nativeReady: true, endpointReady: false } });
  expect(f.primary.integration.auth.status).not.toHaveBeenCalled();
});

test('a missing default never falls through to another profile for reads or login mutations', async () => {
  const f = await fixture();
  f.instances.defaultFor = () => null;
  const signal = new AbortController().signal;
  expect(f.service.supportsLogin('test')).toBe(false);
  expect(f.service.supportsLoginCompletion('test')).toBe(false);
  expect(await f.service.status('test', signal)).toBeNull();
  expect(await f.service.statusMap(signal)).toEqual({});
  expect(await f.service.readinessMap(undefined, signal)).toEqual({});
  await expect(f.service.launchLogin('test')).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  await expect(f.service.completeLogin('test', 'colliding-session', 'synthetic-code'))
    .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  await expect(f.service.loginStatus('test', null, signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  for (const profile of ['primary', 'secondary']) {
    for (const operation of Object.values(f[profile].integration.auth)) expect(operation).not.toHaveBeenCalled();
  }
});

test.each(['status', 'statusMap', 'readinessMap', 'loginStatus'])('%s checks cancellation at port handoff', async (operation) => {
  const f = await fixture();
  const controller = new AbortController();
  const cancellation = new Error('Synthetic auth cancellation');
  const response = Promise.withResolvers();
  void response.promise.then(() => controller.abort(cancellation));
  const original = f.authInstances.authForInstance;
  f.authInstances.authForInstance = (ref) => {
    const owner = original(ref);
    /** @satisfies {import('../../execution-nodes/provider-auth.js').ProviderAuthService} */
    const port = {
      launchLogin: () => owner.launchLogin(),
      completeLogin: (request) => owner.completeLogin(request),
      status: () => response.promise,
      loginStatus: () => response.promise,
    };
    return port;
  };
  const pending = operation === 'status' ? f.service.status('test', controller.signal)
    : operation === 'statusMap' ? f.service.statusMap(controller.signal)
    : operation === 'readinessMap' ? f.service.readinessMap(undefined, controller.signal)
    : f.service.loginStatus('test', null, controller.signal);
  response.resolve(operation === 'loginStatus' ? { state: 'idle', running: false }
    : { authenticated: true, canReauth: true, label: 'primary', source: 'cli' });
  await expect(pending).rejects.toBe(cancellation);
});

test('already-cancelled reads reject before resolving even a missing default', async () => {
  const f = await fixture();
  f.authInstances.defaultFor = mock(() => null);
  const signal = AbortSignal.abort(new Error('Synthetic cancellation'));
  await expect(f.service.status('missing', signal)).rejects.toBe(signal.reason);
  await expect(f.service.statusMap(signal)).rejects.toBe(signal.reason);
  await expect(f.service.readinessMap(undefined, signal)).rejects.toBe(signal.reason);
  await expect(f.service.loginStatus('missing', null, signal)).rejects.toBe(signal.reason);
  expect(f.authInstances.defaultFor).not.toHaveBeenCalled();
});
