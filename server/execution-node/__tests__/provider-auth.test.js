import { expect, mock, test } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { LocalProviderAuthService } from '../local-provider-auth.js';

/** @satisfies {import('@garcon/common/agent-integration').AgentDescriptor} */
const descriptor = {
  id: 'synthetic', label: 'Synthetic', icon: null,
  supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
  supportsImages: false, supportsProjectPathUpdate: false,
  requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [],
};

/** @param {import('@garcon/server-agent-interface').AgentAuth | null} auth */
function service(auth) {
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'auth' | 'descriptor'>} */
  const integration = { descriptor, auth };
  return new LocalProviderAuthService(integration);
}

test('keeps same-provider authentication and colliding login sessions on their bound instances', async () => {
  const profiles = ['first', 'second'].map((profile) => {
    /** @satisfies {import('@garcon/server-agent-interface').AgentAuth} */
    const auth = {
      status: mock(async () => ({ authenticated: true, canReauth: true, label: profile, source: 'cli' })),
      launchLogin: mock(async () => ({ launched: true, alreadyRunning: false, sessionId: 'colliding-session' })),
      completeLogin: mock(async (sessionId, _code) => ({ submitted: true, sessionId })),
      loginStatus: mock(() => ({ state: 'running', running: true, sessionId: 'colliding-session',
        deviceAuth: { url: `https://${profile}.example.test/login` } })),
    };
    return { auth, owner: service(auth) };
  });
  const signal = new AbortController().signal;
  expect(await profiles[0].owner.status(signal)).toMatchObject({ label: 'first' });
  expect(await profiles[1].owner.status(signal)).toMatchObject({ label: 'second' });
  const launch = await profiles[1].owner.launchLogin();
  const poll = await profiles[1].owner.loginStatus({ sessionId: launch.sessionId }, signal);
  expect(poll).toMatchObject({ deviceAuth: { url: 'https://second.example.test/login' } });
  expect(await profiles[1].owner.completeLogin({ sessionId: launch.sessionId, code: 'synthetic-code' }))
    .toEqual({ submitted: true, sessionId: 'colliding-session' });
  expect(profiles[0].auth.launchLogin).not.toHaveBeenCalled();
  expect(profiles[0].auth.completeLogin).not.toHaveBeenCalled();
  expect(profiles[0].auth.loginStatus).not.toHaveBeenCalled();
});

test('does not expose mutable provider status or login results to callers', async () => {
  const status = { authenticated: true, canReauth: true, label: 'Synthetic', source: 'cli' };
  const deviceAuth = { url: 'https://synthetic.example.test/login' };
  const launch = { launched: true, alreadyRunning: false, sessionId: 'synthetic-session', deviceAuth };
  const poll = { state: 'running', running: true, sessionId: launch.sessionId, deviceAuth };
  const owner = service({ status: async () => status, launchLogin: async () => launch, loginStatus: () => poll });
  const signal = new AbortController().signal;
  (await owner.status(signal)).label = 'Caller mutation';
  (await owner.launchLogin()).deviceAuth.url = 'https://changed.example.test';
  (await owner.loginStatus({ sessionId: launch.sessionId }, signal)).deviceAuth.url = 'https://changed.example.test';
  expect(status.label).toBe('Synthetic');
  expect(deviceAuth.url).toBe('https://synthetic.example.test/login');
});

test('rejects cancelled reads before provider entry and drops a late status response', async () => {
  const reply = Promise.withResolvers();
  const auth = { status: mock(() => reply.promise), loginStatus: mock(() => ({ state: 'idle', running: false })) };
  const owner = service(auth);
  const controller = new AbortController();
  const pending = owner.status(controller.signal);
  controller.abort(new Error('Synthetic auth cancellation'));
  reply.resolve({ authenticated: true, canReauth: true, label: 'Synthetic', source: 'cli' });
  await expect(pending).rejects.toBe(controller.signal.reason);
  await expect(owner.status(controller.signal)).rejects.toBe(controller.signal.reason);
  await expect(owner.loginStatus({ sessionId: null }, controller.signal)).rejects.toBe(controller.signal.reason);
  expect(auth.status).toHaveBeenCalledTimes(1);
  expect(auth.status).toHaveBeenCalledWith(controller.signal);
  expect(auth.loginStatus).not.toHaveBeenCalled();
});

test('preserves unsupported capabilities and exact-session completion errors', async () => {
  const owner = service(null);
  const signal = new AbortController().signal;
  expect(await owner.status(signal)).toBeNull();
  expect(await owner.loginStatus({ sessionId: null }, signal)).toEqual({ state: 'idle', running: false });
  await expect(owner.launchLogin()).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
  await expect(owner.completeLogin({ sessionId: 'missing', code: 'synthetic-code' }))
    .rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
  const mismatch = new AgentIntegrationError('AUTH_LOGIN_SESSION_MISMATCH', 'Synthetic session mismatch', false);
  const authenticated = service({ status: async () => ({ authenticated: false, canReauth: false,
    label: 'Synthetic', source: 'none' }), completeLogin: async () => { throw mismatch; } });
  await expect(authenticated.completeLogin({ sessionId: 'missing', code: 'synthetic-code' })).rejects.toBe(mismatch);
});

test('captures completion input and retains the auth receiver through asynchronous mutation', async () => {
  const release = Promise.withResolvers();
  const calls = [];
  const auth = {
    status: async () => ({ authenticated: false, canReauth: false, label: 'Synthetic', source: 'none' }),
    async completeLogin(sessionId, code) {
      await release.promise;
      expect(this).toBe(auth);
      calls.push({ sessionId, code });
      return { submitted: true, sessionId };
    },
  };
  const owner = service(auth);
  const request = { sessionId: 'original-session', code: 'synthetic-code' };
  const pending = owner.completeLogin(request);
  request.sessionId = 'changed-session';
  request.code = 'changed-code';
  release.resolve();
  expect(await pending).toEqual({ submitted: true, sessionId: 'original-session' });
  expect(calls).toEqual([{ sessionId: 'original-session', code: 'synthetic-code' }]);
});
