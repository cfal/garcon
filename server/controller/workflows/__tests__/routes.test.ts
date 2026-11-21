import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowPaths } from '../../../../common/workflow-http.js';
import type { WorkflowExecutionContext, WorkflowRunDetail } from '../../../../common/workflow-runs.js';
import { DomainError } from '../../../common/domain-error.js';
import { LOCAL_SERVER_PRINCIPAL, type HttpRouteContext } from '../../lib/http-route-types.js';
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
  return { service, post, publish };
}

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

test('handoffs cannot be approved by a local CLI or delegated executor; revoked launch never mutates', async () => {
  let revoked = false;
  const { service, post, publish } = fixture(async () => { revoked = true; return () => ({}); });
  await publish(null);
  const decision = { runId: 'run', instanceId: 'review', operationId: 'choice', choice: 'approve' };
  expect((await post(workflowPaths.decide, decision)).status).toBe(403);
  const delegated = { mode: 'executor', key: 'executor', executorId: 'local', expiresAtMs: null } as const;
  expect((await post(workflowPaths.decide, decision, { principal: delegated })).status).toBe(403);
  expect((await post(workflowPaths.runs, { definitionId: 'review', inputs: {} }, {
    ...local, assertCurrent() { if (revoked) throw new DomainError('WORKFLOW_FORBIDDEN', 'Session revoked.', 403); },
  })).status).toBe(403);
  expect(service.listRuns().items).toHaveLength(0);
});
