import { afterEach, beforeEach, expect, test } from 'bun:test';
import { WORKFLOW_API, WORKFLOW_MUTATION_PATHS, WORKFLOW_REQUEST_BYTES } from '../../../../common/workflow-http.js';
import type { WorkflowMutation } from '../../../../common/workflows.js';
import { DomainError } from '../../../common/domain-error.js';
import { getAuthStore } from '../../auth/store.js';
import { AuthService } from '../../auth/service.js';
import { verifyAuthTokenClaims } from '../../auth/token.js';
import { resetServerConfigForTests } from '../../config.js';
import { LOCAL_SERVER_PRINCIPAL, type HttpRouteContext } from '../../lib/http-route-types.js';
import { createWorkflowRoutes } from '../routes.js';
import { fixture, plan } from './fixture.js';

let f: ReturnType<typeof fixture>;
let routes: ReturnType<typeof createWorkflowRoutes>;
let previous: string | undefined;
let browser: HttpRouteContext;
const local = { principal: LOCAL_SERVER_PRINCIPAL };
beforeEach(async () => {
  f = fixture();
  previous = process.env.GARCON_CONFIG_DIR;
  process.env.GARCON_CONFIG_DIR = f.directory;
  resetServerConfigForTests();
  const auth = new AuthService(getAuthStore(), { hash: async value => `test:${value}`, verify: async (value, hash) => hash === `test:${value}` });
  const { token } = await auth.register({ username: 'synthetic-owner', password: 'synthetic-password' });
  const claims = (await verifyAuthTokenClaims(token))!;
  browser = { principal: { mode: 'authenticated', key: claims.ownerKey, ...claims } };
  routes = createWorkflowRoutes(f);
});
afterEach(() => {
  if (previous === undefined) delete process.env.GARCON_CONFIG_DIR;
  else process.env.GARCON_CONFIG_DIR = previous;
  resetServerConfigForTests();
  f.cleanup();
});
async function call(path: string, body?: unknown, context: HttpRouteContext = local) {
  const url = new URL(`${WORKFLOW_API}${path}`, 'http://synthetic.invalid');
  const method = body === undefined ? 'GET' : 'POST';
  const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  return routes[url.pathname]![method]!(request, url, undefined, context);
}
function envelope(mutation: WorkflowMutation, operationId = crypto.randomUUID()) {
  return { expectedStoreId: f.service.bootstrap().storeId, operationId, mutation };
}

test('draft, exact mutation replay, immutable diagram and paged reads share the stored plan', async () => {
  const request = envelope({ action: 'create', plan: plan(), captainChatId: null });
  const created = await call('', request);
  expect(created.status).toBe(201);
  const result = await created.json();
  expect(await (await call('', request)).json()).toEqual(result);
  expect(await (await call('/operation?id=' + result.operationId)).json()).toEqual({ kind: 'completed', result });
  expect((await (await call('')).json()).workflows).toHaveLength(1);
  const detail = await (await call('/detail?id=' + result.workflowId)).json();
  expect(detail.draft.digest).toBe(f.service.detail(result.workflowId).draft.digest);
  expect(await (await call(`/plan?id=${result.workflowId}&planRevision=1`)).json()).toEqual(f.service.detail(result.workflowId).draft);
  expect(await (await call(`/diagram?id=${result.workflowId}&planRevision=1`)).json()).toEqual({ mermaid: f.service.diagram(result.workflowId, 1) });
  for (const kind of ['attempts', 'artifacts', 'activity']) {
    const read = await call(`/${kind}?id=${result.workflowId}&limit=1`);
    expect(read.status).toBe(200);
    expect(Array.isArray((await read.json())[kind])).toBe(true);
  }
  expect((await call('', { ...request, mutation: { ...request.mutation, plan: { ...plan(), title: 'Different' } } })).status).toBe(409);
  f.service.expireResult(result.operationId);
  expect((await call('', request)).status).toBe(409);
});

test('only a current browser session can activate, and stale gate text conflicts', async () => {
  const { workflowId } = f.create();
  const activation = envelope({ action: 'activate', workflowId, manifestDigest: f.service.detail(workflowId).activationDigest });
  expect((await call('/activate', activation, local)).status).toBe(403);
  expect((await call('/activate', activation, browser)).status).toBe(200);
  expect(f.service.detail(workflowId).workflow.desired).toBe('active');
  const principal = browser.principal!;
  if (principal.mode !== 'authenticated') throw new Error('Expected browser');
  await getAuthStore().revokeSession(principal.key, principal.sessionId);
  expect((await call('/activate', activation, browser)).status).toBe(403);
});

test('missing requested plans return 404 without fencing workflow storage', async () => {
  const { workflowId } = f.create();
  const bootstrap = f.service.bootstrap();
  for (const path of ['plan', 'diagram']) {
    for (const [id, revision] of [[workflowId, 999], ['missing-workflow', 1]] as const) {
      expect((await call(`/${path}?id=${id}&planRevision=${revision}`)).status).toBe(404);
      expect(f.service.bootstrap()).toEqual(bootstrap);
      expect((await call(`/${path}?id=${workflowId}&planRevision=1`)).status).toBe(200);
      expect((await call(`/detail?id=${workflowId}`)).status).toBe(200);
    }
  }
});

test('CLI and delegated authority cannot reach browser decisions, including action smuggling', async () => {
  const { workflowId } = f.create();
  const digest = f.service.detail(workflowId).activationDigest;
  const decisions: WorkflowMutation[] = [
    { action: 'activate', workflowId, manifestDigest: digest },
    { action: 'resume', workflowId, planRevision: 1, controlEpoch: 0 },
    { action: 'approve', workflowId, gateId: 'gate', manifestDigest: digest, decision: 'approve' },
    { action: 'retry', workflowId, taskId: 'check', generation: 1, attemptId: 'attempt' },
    { action: 'clear-hold', workflowId, taskId: 'check', generation: 1, evidence: 'Synthetic evidence' },
    { action: 'recheck-publication', workflowId, attemptId: 'attempt', publicationOperationId: 'publication' },
    { action: 'cleanup', workflowId, attemptId: 'attempt', resourceKey: 'resource', expectedHead: 'a'.repeat(40) },
    { action: 'resolve', workflowId, taskId: 'check', generation: 1, attemptId: 'attempt', resolution: 'abandon', evidence: 'Synthetic evidence', commit: null, releaseRisk: false },
    { action: 'cancel', workflowId }, { action: 'archive', workflowId },
  ];
  const executor: HttpRouteContext = { principal: { mode: 'executor', key: 'executor', executorId: 'synthetic', expiresAtMs: null }, assertCurrent() {} };
  for (const mutation of decisions) {
    const path = WORKFLOW_MUTATION_PATHS[mutation.action].slice(WORKFLOW_API.length);
    for (const context of [local, executor]) expect((await call(path, envelope(mutation), context)).status).toBe(403);
    expect((await call('/pause', envelope(mutation), executor)).status).toBe(400);
  }
  expect((await call('/pause', envelope({ action: 'pause', workflowId }), executor)).status).toBe(200);
  expect((await call('/stop', envelope({ action: 'stop', workflowId }), local)).status).toBe(200);
});

test('revoked delegated authority, wrong store and malformed bounds reject before mutations', async () => {
  const request = envelope({ action: 'create', plan: plan(), captainChatId: null });
  let current = true;
  const executor: HttpRouteContext = { principal: { mode: 'executor', key: 'executor', executorId: 'synthetic', expiresAtMs: null }, assertCurrent() {
    if (!current) throw new DomainError('CLI_ACCESS_DENIED', 'Revoked', 403);
  } };
  expect((await call('', request, executor)).status).toBe(201);
  current = false;
  expect((await call('/operation?id=' + request.operationId, undefined, executor)).status).toBe(403);
  expect((await call('', { ...request, expectedStoreId: 'another-store' })).status).toBe(409);
  expect((await call('', { ...request, padding: 'x' })).status).toBe(400);
  expect((await call('?limit=1&limit=2')).status).toBe(400);
  expect((await call('?limit=201')).status).toBe(400);
  expect((await call('', { padding: 'x'.repeat(WORKFLOW_REQUEST_BYTES) })).status).toBe(413);
  expect(f.service.list().workflows).toHaveLength(1);
});

test('disabled storage returns explicit failure but pause and stop remain available', async () => {
  const { workflowId } = f.create();
  f.controls.enabled = false;
  expect((await call('', envelope({ action: 'create', plan: plan(), captainChatId: null }))).status).toBe(503);
  expect((await call('/stop', envelope({ action: 'stop', workflowId }))).status).toBe(200);
  f.store.close();
  const response = await call('');
  expect(response.status).toBe(503);
  expect((await response.json()).errorCode).toBe('WORKFLOW_UNAVAILABLE');
});
