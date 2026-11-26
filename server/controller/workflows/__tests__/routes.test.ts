import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowPaths } from '../../../../common/workflow-http.js';
import type { WorkflowExecutionContext, WorkflowRunDetail } from '../../../../common/workflow-runs.js';
import { DomainError } from '../../../common/domain-error.js';
import { wrapRoutes } from '../../lib/http-route.js';
import { AUTH_DISABLED_SERVER_PRINCIPAL, LOCAL_SERVER_PRINCIPAL, type HttpRouteContext } from '../../lib/http-route-types.js';
import { createWorkflowRoutes, type PrepareWorkflowSettings } from '../../routes/workflows.js';
import { WorkflowEngine } from '../engine.js';
import { WorkflowStore } from '../store.js';

const source = 'version: 1\nname: Review\nsteps:\n  - id: review\n    kind: decision\n    prompt: Proceed?\n    choices: {approve: Approve, reject: Reject}\n';
const local = { principal: LOCAL_SERVER_PRINCIPAL };
const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });

function fixture(prepareSettings: PrepareWorkflowSettings = async () => () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-routes-'));
  close.push(() => rmSync(dir, { recursive: true, force: true }));
  const service = new WorkflowEngine({ store: new WorkflowStore(dir), runner: { async run() { throw new Error('Unexpected dispatch'); } } });
  close.push(() => service.close());
  const routes = createWorkflowRoutes({ service, prepareSettings });
  const post = (path: string, body: unknown, context: HttpRouteContext = local) => {
    const url = new URL(path, 'http://localhost');
    return routes[path]!.POST!(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, undefined, context);
  };
  const publish = (expectedRevision: number | null, text = source) =>
    post(workflowPaths.definitions, { definitionId: 'review', expectedRevision, source: text });
  return { service, routes, post, publish };
}

test('workflow HTTP reads and mutations never cache workspace data or errors', async () => {
  const { routes } = fixture();
  const wrapped = wrapRoutes(routes, { localCapability: 'synthetic-workspace' });
  const request = (path: string, method: 'GET' | 'POST', body?: unknown) => wrapped[path][method](new Request(
    new URL(path, 'http://localhost'), { method, headers: { authorization: 'Bearer synthetic-workspace', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  ));
  for (const [response, status] of [
    [await request(workflowPaths.definitions, 'GET'), 200],
    [await request(workflowPaths.definitions, 'POST', { definitionId: 'd', expectedRevision: null, source }), 201],
    [await request(workflowPaths.definitions, 'POST', { definitionId: 'd', expectedRevision: 1, source: '{}' }), 422],
    [await request(workflowPaths.runs, 'POST', {}), 400],
  ] as const) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

test('invalid source returns actionable field ranges and cannot publish over the current revision', async () => {
  const { publish, service } = fixture();
  expect((await publish(null)).status).toBe(201);
  const invalid = await publish(1, source.replace('kind: decision', 'kind: monitor'));
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ success: false, diagnostics: [expect.objectContaining({
    path: ['steps', 0, 'kind'], range: { start: expect.objectContaining({ line: 5 }), end: expect.anything() },
  })] });
  expect(service.getRevision('review').revision).toBe(1);
  expect((await publish(null)).status).toBe(409);
});

test('repeated launch retains its first revision without consulting a new catalog', async () => {
  let preparations = 0;
  const { post, publish } = fixture(async () => { preparations++; return () => ({}); });
  await publish(null);
  const request = { definitionId: 'review', operationId: 'launch', inputs: {} };
  const started = await post(workflowPaths.runs, request);
  expect(started.status).toBe(201);
  const first = await started.json();
  await publish(1, source.replace('Review', 'Next review'));
  const replay = await post(workflowPaths.runs, request);
  expect(await replay.json()).toMatchObject({ id: first.id, revision: 1, name: 'Review' });
  expect(preparations).toBe(1);
  expect((await post(workflowPaths.runs, { ...request, revision: 2 })).status).toBe(409);
});

test('an added step prepares and records the same executor-qualified folder without changing launch defaults', async () => {
  const contexts: WorkflowExecutionContext[] = [];
  const { post, publish } = fixture(async (_steps, context) => { contexts.push(context); return () => ({}); });
  const remote = '00000000-0000-4000-8000-000000000001';
  const defaultTarget = { executorId: 'local', projectPath: '/local' };
  const executionContext = { defaultTarget, projectPaths: { local: '/local', [remote]: '/original' } };
  await publish(null);
  const started = await post(workflowPaths.runs, { definitionId: 'review', inputs: {}, executionContext });
  const { id } = await started.json() as WorkflowRunDetail;
  const response = await post(workflowPaths.addStep, {
    runId: id, operationId: 'append-command', executionContext: { projectPaths: { [remote]: '/override' } },
    source: JSON.stringify({ id: 'inspect', kind: 'command', executorId: remote, command: 'pwd' }),
  });
  expect(response.status).toBe(200);
  expect(contexts).toEqual([executionContext, { defaultTarget, projectPaths: { local: '/local', [remote]: '/override' } }]);
  const run = await response.json() as WorkflowRunDetail;
  expect(run.executionContext).toEqual(executionContext);
  expect(run.steps.at(-1)?.location).toEqual({ executorId: remote, projectPath: '/override' });
});

test('concurrent resends of an addition return the same single committed amendment', async () => {
  const bothPreparing = Promise.withResolvers<void>();
  let arrivals = 0;
  const { post, publish } = fixture(async steps => {
    if (steps[0]?.id === 'followup') {
      if (++arrivals === 2) bothPreparing.resolve();
      await bothPreparing.promise;
    }
    return () => ({});
  });
  await publish(null);
  const started = await post(workflowPaths.runs, { definitionId: 'review', inputs: {} });
  const { id } = await started.json() as WorkflowRunDetail;
  const request = { runId: id, operationId: 'append-once',
    source: 'id: followup\nkind: decision\nprompt: Proceed?\nchoices: {ok: OK}' };
  const replies = await Promise.all([post(workflowPaths.addStep, request), post(workflowPaths.addStep, request)]);
  for (const reply of replies) {
    expect(reply.status).toBe(200);
    expect((await reply.json() as WorkflowRunDetail).amendments).toMatchObject([{ operationId: request.operationId }]);
  }
});

test('a future listener loses to a decision made while its settings are being prepared', async () => {
  const preparing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const { service, post, publish } = fixture(async steps => {
    if (steps[0]?.id === 'followup') {
      preparing.resolve();
      await resume.promise;
    }
    return () => ({});
  });
  await publish(null, source + '  - {id: keep-open, kind: decision, prompt: Finish?, choices: {ok: OK}}\n');
  const launch = await post(workflowPaths.runs, { definitionId: 'review', inputs: {} });
  const run = await launch.json() as WorkflowRunDetail;
  const append = post(workflowPaths.addStep, {
    runId: run.id, operationId: 'listen',
    executionContext: { defaultTarget: { executorId: 'local', projectPath: '/project' } },
    source: 'id: followup\nkind: agent\non: {kind: once, signal: review.approve}\nprompt: Inspect the approved report.',
  });
  await preparing.promise;
  try {
    service.decide({ runId: run.id, instanceId: run.steps[0]!.instances[0]!.id, operationId: 'choice', choice: 'approve' },
      { id: 'reader', name: 'Reader' });
  } finally {
    resume.resolve();
  }
  const response = await append;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ errorCode: 'WORKFLOW_CONFLICT', error: expect.stringContaining('stored result') });
  const after = service.getRun(run.id);
  expect(after.steps.map(({ step }) => step.id)).toEqual(['review', 'keep-open']);
  expect(after.signals).toMatchObject([{ ref: { stepId: 'review', signal: 'approve' } }]);
  expect(after.amendments).toEqual([]);
});

test('human decisions allow disabled-auth browser sessions but reject local capability CLI or delegated executors', async () => {
  let revoked = false;
  const { service, routes, post, publish } = fixture(async () => { revoked = true; return () => ({}); });
  await publish(null);
  const run = await (await post(workflowPaths.runs, { definitionId: 'review', inputs: {} })).json() as WorkflowRunDetail;
  const instanceId = run.steps[0]!.instances[0]!.id;
  const decision = { runId: run.id, instanceId, operationId: 'choice', choice: 'approve' };

  expect((await post(workflowPaths.decide, decision)).status).toBe(403);
  const wrapped = wrapRoutes(routes, { localCapability: 'synthetic-workspace' });
  const bearerDecide = await wrapped[workflowPaths.decide]!.POST!(new Request(new URL(workflowPaths.decide, 'http://localhost'), {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-workspace', 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  }));
  expect(bearerDecide.status).toBe(403);

  const delegated = { mode: 'executor', key: 'executor', executorId: 'local', expiresAtMs: null } as const;
  expect((await post(workflowPaths.decide, decision, { principal: delegated })).status).toBe(403);

  const authDisabled = await post(workflowPaths.decide, decision, { principal: AUTH_DISABLED_SERVER_PRINCIPAL });
  expect(authDisabled.status).toBe(200);
  expect((await authDisabled.json() as WorkflowRunDetail).signals).toMatchObject([{
    ref: { stepId: 'review', signal: 'approve' },
    source: { kind: 'decision', actor: { id: 'local', name: 'local' }, operationId: 'choice' },
  }]);

  expect((await post(workflowPaths.runs, { definitionId: 'review', inputs: {} }, {
    ...local, assertCurrent() { if (revoked) throw new DomainError('WORKFLOW_FORBIDDEN', 'Session revoked.', 403); },
  })).status).toBe(403);
  expect(service.listRuns().items).toHaveLength(1);
});

test('workflow stop endpoint cancels pending runs idempotently and rejects conflicting operation reuse', async () => {
  const { post, publish } = fixture();
  await publish(null);
  const run = await (await post(workflowPaths.runs, { definitionId: 'review', inputs: {} })).json() as WorkflowRunDetail;
  const instanceId = run.steps[0]!.instances[0]!.id;
  const stopPayload = { runId: run.id, operationId: 'stop-op' };
  const stopped = await post(workflowPaths.stop, stopPayload);
  expect(stopped.status).toBe(200);
  expect((await stopped.json() as WorkflowRunDetail)).toMatchObject({ status: 'attention', steps: [{ instances: [{ id: instanceId, status: 'blocked' }] }] });
  expect((await post(workflowPaths.stop, stopPayload)).status).toBe(200);
  expect((await post(workflowPaths.stop, { ...stopPayload, instanceId })).status).toBe(409);
});
