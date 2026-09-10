import { afterEach, expect, test } from 'bun:test';
import { createProviderAuthFixture } from '../../agents/__tests__/provider-auth-fixture.js';
import createAgentRoutes from '../agents.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture() {
  const f = await createProviderAuthFixture();
  fixtures.push(f);
  /** @satisfies {Pick<import('../../api-providers/service.js').ApiProviderService, 'getCatalog'>} */
  const apiProviders = { getCatalog: () => [] };
  const routes = createAgentRoutes({ agents: f.agents, apiProviders });
  return {
    ...f,
    get(path, signal) {
      const request = new Request(`http://localhost${path}`, { signal });
      return routes[new URL(request.url).pathname].GET(request, new URL(request.url));
    },
    post(path, body, signal) {
      return routes[path].POST(new Request(`http://localhost${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      }));
    },
  };
}

test('provider-only auth routes use the configured default for status, readiness and colliding login sessions', async () => {
  const f = await fixture();
  f.integrations.get = () => f.secondary.integration;
  f.integrations.require = () => f.secondary.integration;
  f.integrations.list = () => [f.secondary.integration];
  expect(await (await f.get('/api/v1/agents/auth?agent=test')).json()).toEqual({ test: {
    authenticated: true, canReauth: true, label: 'primary', source: 'cli',
  } });
  expect(await (await f.get('/api/v1/agents/auth')).json()).toMatchObject({ test: { label: 'primary' } });
  expect(await (await f.get('/api/v1/agents/readiness')).json()).toMatchObject({ test: { nativeReady: true } });
  expect((await f.post('/api/v1/agents/auth/login', { agentId: 'test' })).status).toBe(200);
  expect(await (await f.get('/api/v1/agents/auth/login?agent=test&session=colliding-session')).json())
    .toMatchObject({ deviceAuth: { url: 'https://primary.example.test/login' } });
  const completed = await f.post('/api/v1/agents/auth/login/complete', {
    agentId: 'test', sessionId: 'colliding-session', code: 'synthetic-code',
  });
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({ submitted: true, sessionId: 'colliding-session' });
  for (const operation of Object.values(f.secondary.integration.auth)) expect(operation).not.toHaveBeenCalled();
});

test.each(['/api/v1/agents/auth?agent=test', '/api/v1/agents/auth', '/api/v1/agents/readiness'])(
  '%s forwards request cancellation and never delivers a late successful auth result', async (path) => {
    const f = await fixture();
    const called = Promise.withResolvers();
    const reply = Promise.withResolvers();
    f.primary.integration.auth.status.mockImplementation((signal) => {
      called.resolve(signal);
      return reply.promise;
    });
    const controller = new AbortController();
    const pending = f.get(path, controller.signal);
    const signal = await called.promise;
    controller.abort(new Error('Synthetic request cancellation'));
    reply.resolve({ authenticated: true, canReauth: true, label: 'primary', source: 'cli' });
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.text()).toBe('');
    expect(signal.aborted).toBe(true);
    expect(f.secondary.integration.auth.status).not.toHaveBeenCalled();
  },
);

test('login polling observes request cancellation before entering the owner', async () => {
  const f = await fixture();
  const response = await f.get('/api/v1/agents/auth/login?agent=test', AbortSignal.abort(new Error('Synthetic cancellation')));
  expect(response.status).toBe(499);
  expect(await response.text()).toBe('');
  expect(f.primary.integration.auth.loginStatus).not.toHaveBeenCalled();
});

test.each(['launch', 'complete'])('an admitted login %s outlives request cancellation', async (operation) => {
  const f = await fixture();
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const controller = new AbortController();
  const method = operation === 'launch' ? 'launchLogin' : 'completeLogin';
  f.primary.integration.auth[method].mockImplementation(() => { entered.resolve(); return reply.promise; });
  const path = operation === 'launch' ? '/api/v1/agents/auth/login' : '/api/v1/agents/auth/login/complete';
  const pending = f.post(path, { agentId: 'test', sessionId: 'colliding-session', code: 'synthetic-code' }, controller.signal);
  await entered.promise;
  controller.abort(new Error('Synthetic disconnected login request'));
  const result = operation === 'launch'
    ? { launched: true, alreadyRunning: false, sessionId: 'colliding-session' }
    : { submitted: true, sessionId: 'colliding-session' };
  reply.resolve(result);
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(f.primary.integration.auth[method]).toHaveBeenCalledTimes(1);
  expect(f.secondary.integration.auth[method]).not.toHaveBeenCalled();
});
