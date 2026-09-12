import { describe, expect, it, mock } from 'bun:test';
import type { AgentSessionConfiguration, AgentSessionConfigurationPrepareRequest } from '@garcon/server-agent-interface';
import { createOpenCodeSessionConfiguration, prepareOpenCodeConfigurationTurn, reconcileOpenCodePermissions } from '../session-configuration.js';
import { createOpenCodeTurnContext, type OpenCodeSession } from '../turn-events.js';
import { OpenCodeOperationRoutes } from '../operation-routes.js';
import { mapPermissionMode } from '../permissions.js';
import { nativePermissionsFixture } from './native-permissions-fixture.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const configuration: AgentSessionConfiguration = {
  model: 'provider/model', permissionMode: 'default', thinkingMode: 'none',
  settings: { ownerId: 'opencode', schemaVersion: 1, values: {} }, endpoint: null,
};

function captureFixture() {
  const turn = createOpenCodeTurnContext({ runId: 'run-1', publish() {} });
  const session: OpenCodeSession = {
    configurationEpoch: 1, configurationPreparing: false, status: 'running',
    chatId: 'chat-1', model: configuration.model, thinkingVariant: 'low', permissionMode: 'default',
    directory: '/repo', startedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: 1,
    providerWorkRequiresQuiescence: false, activeSteeringDeliveries: 0, deferredTerminal: null,
    pendingSteeringRevertMessageId: null, turn,
  };
  const sessions = new Map([['session-1', session]]);
  const routes = new OpenCodeOperationRoutes(logger);
  const route = routes.register('session-1', 'chat-1', turn, true, 'default', '/repo');
  let generation = 1;
  const service = createOpenCodeSessionConfiguration({ session: id => sessions.get(id),
    generation: () => generation, shuttingDown: () => false, routes });
  const controller = new AbortController();
  const request: AgentSessionConfigurationPrepareRequest = {
    expected: { chatId: 'chat-1', agentSessionId: 'session-1', projectPath: '/repo', nativeSession: null },
    previous: configuration, next: { ...configuration, permissionMode: 'manualBypass' }, signal: controller.signal,
  };
  return { service, session, sessions, routes, route, request, controller,
    retire: () => { generation += 1; } };
}

async function capture(fixture: ReturnType<typeof captureFixture>) {
  const result = await fixture.service.prepare(fixture.request);
  if (result.kind !== 'prepared') throw new Error(`Expected prepared, received ${result.kind}`);
  return result.target;
}

describe('OpenCode configuration capture', () => {
  it('reports transient turn preparation as retryable busy without changing its epoch', () => {
    const fixture = captureFixture();
    fixture.session.configurationPreparing = true;
    const epoch = fixture.session.configurationEpoch;
    const request = { chatId: 'chat-1', agentSessionId: 'session-1', projectPath: '/repo',
      permissionMode: 'default' as const, operation: { runId: 'synthetic-run', publish() {} } };
    expect(() => prepareOpenCodeConfigurationTurn(request, () => fixture.session))
      .toThrow(expect.objectContaining({ code: 'SESSION_BUSY', retryable: true }));
    expect(fixture.session.configurationEpoch).toBe(epoch);
    expect(fixture.session.configurationPreparing).toBe(true);
  });

  it('rejects malformed native references with the typed target conflict', async () => {
    const fixture = captureFixture();
    expect(await fixture.service.prepare({ ...fixture.request, expected: { ...fixture.request.expected,
      nativeSession: { ownerId: 'opencode', schemaVersion: 1, value: { path: 42 } } } }))
      .toEqual({ kind: 'rejected', reason: 'target-conflict' });
  });

  it('updates only the captured live permission route without changing steering model or variant', async () => {
    const fixture = captureFixture();
    fixture.request = { ...fixture.request, next: { ...fixture.request.next, model: 'provider/next', thinkingMode: 'high' } };
    const target = await capture(fixture);
    expect(fixture.route.permissionMode).toBe('default');
    expect(await fixture.service.commit(target, fixture.controller.signal)).toEqual({ kind: 'applied' });
    expect(fixture.route.permissionMode).toBe('manualBypass');
    expect(fixture.session.permissionMode).toBe('manualBypass');
    expect(fixture.session.model).toBe(configuration.model);
    expect(fixture.session.thinkingVariant).toBe('low');
    expect(await fixture.service.commit(target, fixture.controller.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
  });

  it('reports initial absence without creating an idle runtime', async () => {
    const fixture = captureFixture();
    fixture.sessions.clear();
    expect(await fixture.service.prepare(fixture.request)).toEqual({ kind: 'not-required' });
    expect(fixture.sessions.size).toBe(0);
  });

  for (const [label, change] of [
    ['chat', { chatId: 'chat-2' }],
    ['directory', { projectPath: '/elsewhere' }],
    ['native session', { nativeSession: { ownerId: 'opencode', schemaVersion: 1, value: { agentSessionId: 'session-2' } } }],
    ['native path', { nativeSession: { ownerId: 'opencode', schemaVersion: 1, value: { path: 'foreign' } } }],
  ] as const) {
    it(`rejects a conflicting ${label}`, async () => {
      const fixture = captureFixture();
      expect(await fixture.service.prepare({ ...fixture.request, expected: { ...fixture.request.expected, ...change } }))
        .toEqual({ kind: 'rejected', reason: 'target-conflict' });
    });
  }

  const invalidations: Record<string, (fixture: ReturnType<typeof captureFixture>) => void> = {
    removal: fixture => { fixture.sessions.clear(); },
    replacement: fixture => { fixture.sessions.set('session-1', { ...fixture.session }); },
    'same-object successor': fixture => { fixture.session.configurationEpoch += 1; },
    'route retirement': fixture => { fixture.routes.unregister(fixture.route); },
    'process retirement': fixture => { fixture.retire(); },
    admission: fixture => { fixture.session.configurationPreparing = true; },
    'turn settlement': fixture => { fixture.session.status = 'completed'; },
  };
  for (const [label, invalidate] of Object.entries(invalidations)) {
    it(`rejects ${label} after preparation`, async () => {
      const fixture = captureFixture();
      const target = await capture(fixture);
      invalidate(fixture);
      expect(await fixture.service.commit(target, fixture.controller.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
      expect(fixture.session.permissionMode).toBe('default');
    });
  }

  it('invalidates an earlier capture when another preparation wins', async () => {
    const fixture = captureFixture();
    const first = await capture(fixture);
    const second = await capture(fixture);
    expect(await fixture.service.commit(first, fixture.controller.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
    expect(await fixture.service.commit(second, fixture.controller.signal)).toEqual({ kind: 'applied' });
  });

  for (const method of ['cancel', 'abort'] as const) {
    it(`withdraws the capture on ${method}`, async () => {
      const fixture = captureFixture();
      const target = await capture(fixture);
      if (method === 'cancel') fixture.service.cancel(target);
      else fixture.controller.abort();
      expect((await fixture.service.commit(target, new AbortController().signal)).kind).toBe('rejected');
      expect(fixture.route.permissionMode).toBe('default');
    });
  }

  for (const permissionMode of ['acceptEdits', 'bypassPermissions'] as const) {
    it(`defers native-changing ${permissionMode} until a turn reasserts persisted configuration`, async () => {
      const fixture = captureFixture();
      const result = await fixture.service.prepare({ ...fixture.request, next: { ...configuration, permissionMode } });
      if (result.kind !== 'prepared') throw new Error('Expected capture');
      expect(await fixture.service.commit(result.target, fixture.controller.signal)).toEqual({ kind: 'not-required' });
      expect(fixture.route.permissionMode).toBe('default');
    });
  }

  it('refuses a known bypass exit without changing the live route', async () => {
    const fixture = captureFixture();
    fixture.session.permissionMode = 'bypassPermissions';
    await expect(fixture.service.prepare(fixture.request)).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', retryable: false });
    expect(fixture.session.permissionMode).toBe('bypassPermissions');
  });
});

function reconciliationFixture(mode: Parameters<typeof nativePermissionsFixture>[0] = 'default') {
  const session = nativePermissionsFixture(mode);
  const controller = new AbortController();
  const input: Parameters<typeof reconcileOpenCodePermissions>[0] = {
    client: { session }, sessionId: 'session-1', scope: { directory: '/repo' },
    mode: 'acceptEdits', signal: controller.signal, validate() {},
  };
  return { session, input, controller };
}

describe('OpenCode native permission reconciliation', () => {
  it('appends a changed policy once across repeated resumes and equivalent native modes', async () => {
    const { session, input } = reconciliationFixture();
    for (let attempt = 0; attempt < 3; attempt += 1) await reconcileOpenCodePermissions(input);
    expect(session.update).toHaveBeenCalledTimes(1);
    await reconcileOpenCodePermissions({ ...input, mode: 'default' });
    await reconcileOpenCodePermissions({ ...input, mode: 'manualBypass' });
    expect(session.update).toHaveBeenCalledTimes(2);
  });

  it('refuses historical bypass rules even when the tail already asks', async () => {
    const { session, input } = reconciliationFixture('bypassPermissions');
    await session.update({ sessionID: input.sessionId, directory: '/repo', permission: mapPermissionMode('default') }, { signal: input.signal });
    session.update.mockClear();
    await expect(reconcileOpenCodePermissions({ ...input, mode: 'default' })).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
    expect(session.update).not.toHaveBeenCalled();
  });

  it('preserves preexisting user rules when appending the desired session policy', async () => {
    const { session, input } = reconciliationFixture();
    await session.update({ sessionID: input.sessionId, directory: '/repo', permission: [{ permission: 'read', pattern: '*.private', action: 'deny' }] }, { signal: input.signal });
    await reconcileOpenCodePermissions(input);
    const result = await session.get({ sessionID: input.sessionId, directory: '/repo' }, { signal: input.signal });
    expect(result.data.permission).toContainEqual({ permission: 'read', pattern: '*.private', action: 'deny' });
  });

  for (const change of [{ id: 'foreign' }, { directory: '/elsewhere' }, { permission: [{ permission: '*', pattern: '*', action: 'invalid' }] }]) {
    it('refuses conflicting or malformed native evidence before writing', async () => {
      const { session, input } = reconciliationFixture();
      input.client.session.get = mock(async () => ({ data: { id: input.sessionId, directory: '/repo', permission: [], ...change } }));
      await expect(reconcileOpenCodePermissions(input)).rejects.toThrow();
      expect(session.update).not.toHaveBeenCalled();
    });
  }

  it('rejects cancellation after native mutation, then recognizes the landed suffix on the next attempt', async () => {
    const { session, input, controller } = reconciliationFixture();
    const nativeUpdate = session.update;
    input.client.session.update = mock(async (parameters, options) => {
      const result = await nativeUpdate(parameters, options);
      controller.abort(new Error('admission cancelled'));
      return result;
    });
    await expect(reconcileOpenCodePermissions(input)).rejects.toThrow('admission cancelled');
    await reconcileOpenCodePermissions({ ...input, signal: new AbortController().signal });
    expect(nativeUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses a successful reply that does not confirm the appended rules', async () => {
    const { session, input } = reconciliationFixture();
    input.client.session.update = mock(async parameters => session.get(parameters, { signal: input.signal }));
    await expect(reconcileOpenCodePermissions(input)).rejects.toThrow('did not confirm');
  });
});
