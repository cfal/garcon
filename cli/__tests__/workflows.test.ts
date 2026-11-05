import { afterEach, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowHttpMutationRequest } from '@garcon/common/workflow-http';
import type { WorkflowOperationResult, WorkflowPlan } from '@garcon/common/workflows';
import { parseCliArgs } from '../args.js';
import { readWorkflowStdin, runWorkflowCommand } from '../workflows.js';
import type { GarconClient } from '../garcon-client.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temporary = join(homedir(), 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(join(temporary, 'workflow-cli-'));
  roots.push(root);
  const plan: WorkflowPlan = { title: 'Synthetic approval', goal: { kind: 'artifacts', taskIds: ['gate'] },
    policy: { allowRemoteWrites: false, concurrency: 1 }, tasks: [{ id: 'gate', title: 'Gate', dependsOn: [],
      spec: { kind: 'approval', purpose: 'manual', requirements: [] }, acceptance: [],
      retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false } }] };
  const file = join(root, 'plan.json');
  await fs.writeFile(file, JSON.stringify(plan));
  let previous: WorkflowOperationResult = { kind: 'not-found' };
  const mutate = mock(async (request: WorkflowHttpMutationRequest) => ({ operationId: request.operationId, workflowId: 'workflow-1', revision: 2, collectionRevision: 1 }));
  const client = { defaultExecutorId: 'local',
    readWorkflow: mock(async () => ({ workflow: 'synthetic' })),
    getWorkflowBootstrap: mock(async () => ({ storeId: 'store-1', revision: 0, enabled: true })),
    getWorkflowOperation: mock(async () => previous), mutateWorkflow: mutate,
  } satisfies Pick<GarconClient, 'readWorkflow' | 'getWorkflowBootstrap' | 'getWorkflowOperation' | 'mutateWorkflow' | 'defaultExecutorId'>;
  const results: string[] = [], diagnostics: string[] = [];
  const output = { result: (value: string) => { results.push(value); }, diagnostic: (value: string) => { diagnostics.push(value); } };
  const command = (args: string[]) => {
    const parsed = parseCliArgs(['--config-dir', root, '--runtime', 'controller', 'workflow', ...args], {});
    if (parsed.kind !== 'workflow') throw new Error('Expected workflow command');
    return parsed;
  };
  return { root, file, command, client, mutate, output, results, diagnostics, setPrevious(value: WorkflowOperationResult) { previous = value; } };
}

test('workflow arguments reject browser decisions, missing preconditions and repeated options', () => {
  for (const args of [['activate', 'wf'], ['approve', 'wf'], ['resume', 'wf'], ['retry', 'wf'], ['resolve', 'wf'],
    ['cancel', 'wf'], ['archive', 'wf'], ['plan', 'wf', '--file', 'p.json'], ['retry-operation', '--payload', 'p.json'],
    ['create', '--plan', 'a', '--plan', 'b'], ['show', 'wf', '--operation-id', 'op'], ['list', '--limit', '201']]) {
    expect(() => parseCliArgs(['workflow', ...args], {})).toThrow();
  }
  expect(parseCliArgs(['workflow', 'diagram', 'wf', '--plan-revision', '3'], {})).toMatchObject({
    kind: 'workflow', operation: { action: 'read', query: { kind: 'diagram', id: 'wf', planRevision: 3 } },
  });
  for (const [action, flag, kind, key, value] of [
    ['inspect-plan', '--plan-revision', 'plan', 'planRevision', 3],
    ['attempt', '--attempt-id', 'attempt', 'attemptId', 'historical'],
    ['gate', '--gate-id', 'gate', 'gateId', 'publication'],
  ] as const) expect(parseCliArgs(['workflow', action, 'wf', flag, String(value)], {})).toMatchObject({
    kind: 'workflow', operation: { action: 'read', query: { kind, id: 'wf', [key]: value } },
  });
});

test('workflow plan stdin is bounded, UTF-8 validated and read where the CLI runs', async () => {
  expect(parseCliArgs(['workflow', 'create', '--plan', '-'], {})).toMatchObject({ operation: { action: 'create', file: '-' } });
  const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  expect(await readWorkflowStdin(stream(new TextEncoder().encode('{"title":"synthetic"}')))).toEqual({ title: 'synthetic' });
  await expect(readWorkflowStdin(stream(new Uint8Array([0xff])))).rejects.toBeDefined();
  await expect(readWorkflowStdin(stream(new Uint8Array(2 * 1024 * 1024)))).rejects.toThrow('size limit');
  const abort = new AbortController();
  const waiting = readWorkflowStdin(new ReadableStream<Uint8Array>({}), abort.signal);
  abort.abort(new Error('Synthetic canceled stdin'));
  await expect(waiting).rejects.toThrow('Synthetic canceled stdin');
});

test('persists a private exact recovery payload and prints its identity before submission', async () => {
  const f = await fixture();
  await runWorkflowCommand(f.command(['create', '--plan', f.file, '--operation-id', 'op-1', '--json']), f.client, f.output, undefined, () => {
    expect(f.diagnostics.join('\n')).toContain('Operation: op-1');
    expect(f.diagnostics.join('\n')).toContain("--runtime 'controller'");
  });
  const file = join(f.root, 'workflow-recovery', 'op-1.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(saved.request).toEqual(f.mutate.mock.calls[0]![0]);
  expect(saved.connection).toEqual({ configDir: f.root, runtime: 'controller', serverUrl: null, executorId: 'local' });
  expect(f.mutate).toHaveBeenCalledTimes(1);
  const result = JSON.parse(f.results[0]!);
  f.setPrevious({ kind: 'completed', result });
  await runWorkflowCommand(f.command(['retry-operation', '--payload', file, '--operation-id', 'op-1', '--json']), f.client, f.output);
  expect(f.mutate).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.results[1]!)).toEqual(result);
});

test('lost replies do not retry; explicit recovery uses identical payload and rejects changed selectors or expired results', async () => {
  const f = await fixture();
  f.mutate.mockRejectedValueOnce(new Error('Synthetic lost reply'));
  await expect(runWorkflowCommand(f.command(['create', '--plan', f.file, '--operation-id', 'op-2']), f.client, f.output)).rejects.toThrow('not confirmed');
  expect(f.mutate).toHaveBeenCalledTimes(1);
  const file = join(f.root, 'workflow-recovery', 'op-2.json');
  const retry = f.command(['retry-operation', '--payload', file, '--operation-id', 'op-2']);
  await runWorkflowCommand(retry, f.client, f.output);
  expect(f.mutate).toHaveBeenCalledTimes(2);
  expect(f.mutate.mock.calls[1]).toEqual(f.mutate.mock.calls[0]);
  await expect(runWorkflowCommand({ ...retry, runtime: 'executor' }, f.client, f.output)).rejects.toThrow('selector changed');
  f.setPrevious({ kind: 'result-expired' });
  await expect(runWorkflowCommand(retry, f.client, f.output)).rejects.toThrow('expired');
  expect(f.mutate).toHaveBeenCalledTimes(2);
  f.client.getWorkflowBootstrap.mockResolvedValue({ storeId: 'other-store', revision: 0, enabled: true });
  await expect(runWorkflowCommand(retry, f.client, f.output)).rejects.toThrow('different workflow store');
});

test('reads create no recovery files and drafts are loaded from the CLI filesystem without rewriting repository paths', async () => {
  const f = await fixture();
  await runWorkflowCommand(f.command(['show', 'wf', '--json']), f.client, f.output);
  expect(f.client.readWorkflow).toHaveBeenCalledWith({ kind: 'show', id: 'wf' }, undefined);
  expect(f.client.getWorkflowBootstrap).not.toHaveBeenCalled();
  expect(await fs.readdir(f.root)).toEqual(['plan.json']);
  await runWorkflowCommand(f.command(['plan', 'workflow-1', '--file', f.file, '--expected-plan-revision', '1']), f.client, f.output);
  expect(f.mutate.mock.calls[0]![0].mutation).toMatchObject({ action: 'plan', expectedPlanRevision: 1, workflowId: 'workflow-1' });
});
