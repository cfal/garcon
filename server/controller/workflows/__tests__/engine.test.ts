import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { parseWorkflowDefinition } from '../../../../common/workflow-definition.js';
import type { WorkflowRunStep } from '../../../../common/workflow-runs.js';
import { WorkflowEngine, type WorkflowEngineOptions } from '../engine.js';
import { WORKFLOW_LIMITS } from '../limits.js';
import type { WorkflowAttemptCallbacks, WorkflowAttemptRequest, WorkflowAttemptResult, WorkflowRunner } from '../runner.js';
import { WorkflowStore } from '../store.js';

const ACTOR = { id: 'synthetic-person', name: 'Example Reader' };
const REMOTE = '23200000-0000-4000-8000-000000000001';
const LOCAL = { defaultTarget: { executorId: 'local', projectPath: '/synthetic/local' } };
const RESEARCH = readFileSync(new URL('../../../../common/workflow-definition/fixtures/research.workflow.yaml', import.meta.url), 'utf8');

class ControlledRunner implements WorkflowRunner {
  readonly attempts: {
    request: WorkflowAttemptRequest;
    callbacks: WorkflowAttemptCallbacks;
    chatId: string;
    turnId: string;
    finish: (result: WorkflowAttemptResult) => void;
  }[] = [];

  constructor(private readonly attach = true) {}

  run(request: WorkflowAttemptRequest, callbacks: WorkflowAttemptCallbacks): Promise<WorkflowAttemptResult> {
    const chatId = randomUUID();
    const turnId = randomUUID();
    if (this.attach) callbacks.attachChat(chatId, turnId);
    const result = Promise.withResolvers<WorkflowAttemptResult>();
    this.attempts.push({ request, callbacks, chatId, turnId, finish: result.resolve });
    return result.promise;
  }

  async next(stepId: string, index = 0) {
    await until(() => this.attempts.filter(attempt => attempt.request.stepId === stepId).length > index);
    return this.attempts.filter(attempt => attempt.request.stepId === stepId)[index]!;
  }
}

async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 50 && !predicate(); turn++) await setImmediate();
  expect(predicate()).toBe(true);
}

async function drain() {
  for (let turn = 0; turn < 4; turn++) await setImmediate();
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'garcon-workflow-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return (runner = new ControlledRunner(), options: Partial<WorkflowEngineOptions> = {}, beforeCommit?: () => void) => {
    const store = new WorkflowStore(dir, beforeCommit);
    const service = new WorkflowEngine({ store, runner, ...options });
    cleanups.push(() => service.close());
    return { store, service, runner };
  };
}

function parsed(source: string) {
  const result = parseWorkflowDefinition(source);
  expect(result.diagnostics).toEqual([]);
  return result.definition!;
}

function publish(service: WorkflowEngine, source = RESEARCH, id = 'research', expectedRevision: number | null = null) {
  return service.publish({ definitionId: id, expectedRevision, source }, parsed(source));
}

function step(service: WorkflowEngine, runId: string, stepId: string): WorkflowRunStep {
  return service.getRun(runId).steps.find(item => item.step.id === stepId)!;
}

function finding(finding_id: string, claim = 'Synthetic claim') {
  return { signal: 'finding_ready', payload: { finding_id, claim, evidence: 'Synthetic evidence' } };
}

function success(text: string): WorkflowAttemptResult {
  return { kind: 'succeeded', output: { kind: 'complete', text } };
}

test('pins exact published and isolated draft snapshots, validates inputs, and deduplicates launch across revisions', () => {
  const { service } = workspace()();
  const source = `# original whitespace
version: 1
name: Example
inputs:
  title: { type: string }
  enabled: { type: boolean, default: false }
  count: { type: number, default: 0 }
  extra: { type: json, default: null }
steps:
  - id: ask
    kind: decision
    prompt: "{{title}} {{enabled}} {{count}} {{extra}}"
    bindings: {title: inputs.title, enabled: inputs.enabled, count: inputs.count, extra: inputs.extra}
    choices: { yes: "Yes" }
`;
  expect(publish(service, source).source).toBe(source);
  expect(() => service.startRun({ definitionId: 'research', inputs: {} })).toThrow('requires a string');
  expect(() => service.startRun({ definitionId: 'research', inputs: { title: 'test', unknown: true } })).toThrow('Unknown workflow input');
  expect(() => service.startRun({ definitionId: 'research', inputs: { title: 1 } })).toThrow('requires a string');
  expect(() => service.startRun({ definitionId: 'research', inputs: { title: 'test', count: Infinity } })).toThrow('valid JSON');
  expect(() => service.startRun({
    definitionId: 'research', inputs: { title: 'test' }, executionContext: { defaultTarget: { executorId: 'bogus', projectPath: '/test' } },
  })).toThrow('valid executor id');
  const start = { definitionId: 'research', inputs: { title: 'Synthetic' }, operationId: 'launch-1' };
  const first = service.startRun(start);
  expect(() => publish(service, source)).toThrow('published workflow changed');
  const revised = source.replace('name: Example', 'name: Later');
  expect(publish(service, revised, 'research', 1)).toMatchObject({ revision: 2, source: revised });
  expect(service.startRun(start).id).toBe(first.id);
  expect(() => service.startRun({ ...start, inputs: { title: 'Different' } })).toThrow('different launch');

  const testRequest = { source, inputs: { title: 'Draft' }, operationId: 'draft-1' };
  const draft = service.testWorkflowDraft(testRequest, parsed(source));
  expect(service.testWorkflowDraft(testRequest, parsed(source)).id).toBe(draft.id);
  expect(service.getRun(draft.id)).toMatchObject({ kind: 'test', definitionId: null, pinnedRevision: { source, revision: null } });
  expect(service.getRun(first.id)).toMatchObject({
    pinnedRevision: { source, revision: 1 }, inputs: { title: 'Synthetic', enabled: false, count: 0, extra: null },
    steps: [{ instances: [{ prompt: 'Synthetic false 0 null', status: 'awaiting-decision' }] }],
  });
  expect(service.listDefinitions().items).toEqual([expect.objectContaining({ id: 'research', revision: 2, name: 'Later' })]);
  const page = service.listRuns({ limit: 1 });
  expect(page.items.map(run => run.id)).toEqual([draft.id]);
  expect(service.listRuns({ cursor: page.nextCursor! }).items.map(run => run.id)).toEqual([first.id]);
  expect(() => service.listRuns({ limit: WORKFLOW_LIMITS.runsPage + 1 })).toThrow('Page size');
  service.deleteDefinition('research', 2);
  expect(service.listDefinitions().items).toEqual([]);
  expect(() => service.startRun({ definitionId: 'research', inputs: {} })).toThrow('not found');
  expect(service.getRun(first.id).pinnedRevision.source).toBe(source);
});

test('schedules keyed signals early, respects running limits, includes queued manual items, and holds for an attributed decision', async () => {
  const { service, runner } = workspace()();
  publish(service, RESEARCH.replace('maxConcurrency: 2', 'maxConcurrency: 1'));
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  const f1 = research.callbacks.emit(finding('F1'));
  expect(f1.source).toEqual({ kind: 'attempt', attemptId: research.request.attemptId, chatId: research.chatId, turnId: research.turnId });
  expect(research.callbacks.emit({ signal: 'finding_ready', payload: { evidence: 'Synthetic evidence', claim: 'Synthetic claim', finding_id: 'F1' } }).id).toBe(f1.id);
  expect(() => research.callbacks.emit(finding('F1', 'Different'))).toThrow('different payload');
  expect(() => research.callbacks.emit({ signal: 'finding_ready', payload: { finding_id: 'invalid' } })).toThrow('requires a string value');
  expect(() => research.callbacks.emit({ signal: 'turn_completed' })).toThrow('Only Garcon');
  const v1 = await runner.next('verify');
  expect(v1.request).toMatchObject({ kind: 'agent', prompt: expect.stringContaining('Verify finding F1') });
  research.callbacks.emit(finding('F2'));
  const add = { runId: id, stepId: 'verify', operationId: 'manual-1', key: 'manual', payload: finding('manual').payload };
  const manual = service.addItem(add, ACTOR);
  expect(service.addItem(add, ACTOR).id).toBe(manual.id);
  expect(manual.source).toEqual({ kind: 'manual', actor: ACTOR, operationId: 'manual-1' });
  expect(() => service.addItem({ ...add, key: 'changed' }, ACTOR)).toThrow('different request');
  expect(step(service, id, 'verify').instances.map(instance => instance.status)).toEqual(['running', 'ready', 'ready']);
  expect(service.listActiveChats().items).toEqual(expect.arrayContaining([
    expect.objectContaining({ chatId: research.chatId, runId: id, runName: 'Verify synthetic research', runStatus: 'running' }),
    expect.objectContaining({ chatId: v1.chatId, runId: id }),
  ]));
  await drain();
  expect(runner.attempts.map(attempt => attempt.request.stepId)).toEqual(['research', 'verify']);

  research.finish({ kind: 'succeeded', output: { kind: 'incomplete' } });
  await until(() => step(service, id, 'verify').intake === 'closed');
  expect(service.addItem(add, ACTOR).id).toBe(manual.id);
  expect(() => service.addItem({ ...add, key: 'late', payload: finding('late').payload, operationId: 'manual-2' }, ACTOR)).toThrow('closed to new items');
  expect(() => research.callbacks.emit(finding('late'))).toThrow('no live turn');
  v1.finish(success('verdict 1'));
  const v2 = await runner.next('verify', 1);
  expect(step(service, id, 'summary').instances).toEqual([]);
  v2.finish(success('verdict 2'));
  const v3 = await runner.next('verify', 2);
  expect(step(service, id, 'summary').instances).toEqual([]);
  v3.finish(success('manual verdict'));
  const summary = await runner.next('summary');
  expect(summary.request).toMatchObject({ prompt: expect.stringContaining('["verdict 1","verdict 2","manual verdict"]') });
  summary.finish(success('Synthetic report'));
  await until(() => step(service, id, 'decide').instances.length === 1);
  const instance = step(service, id, 'decide').instances[0]!;
  expect(instance).toMatchObject({ status: 'awaiting-decision', bindings: { report: 'Synthetic report' }, attempts: [] });
  const decision = { runId: id, instanceId: instance.id, operationId: 'decision-1', choice: 'accept' };
  expect(() => service.decide({ ...decision, actor: ACTOR }, ACTOR)).toThrow('unexpected fields');
  const accepted = service.decide(decision, ACTOR);
  expect(service.decide(decision, ACTOR)).toEqual(accepted);
  expect(accepted.source).toEqual({ kind: 'decision', actor: ACTOR, operationId: 'decision-1' });
  expect(() => service.decide({ ...decision, choice: 'stop', operationId: 'decision-2' }, ACTOR)).toThrow('no longer open');
  expect(service.getRun(id).status).toBe('succeeded');
  expect(service.listActiveChats().items).toEqual([]);
});

test('closes an empty join on success, not on partial data, and runs independent literal commands', async () => {
  const { service, runner } = workspace()();
  const source = RESEARCH + `
  - id: needs_text
    kind: decision
    on: { kind: once, signal: research.turn_completed }
    prompt: "{{response}}"
    bindings: { response: signal }
    choices: { ready: Ready }
  - id: completion_only
    kind: command
    on: { kind: once, signal: research.turn_completed }
    command: 'printf "{{literal}}"'
`;
  publish(service, source);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  expect(step(service, id, 'summary').instances).toEqual([]);
  research.finish({ kind: 'succeeded', output: { kind: 'incomplete' } });
  const summary = await runner.next('summary');
  const command = await runner.next('completion_only');
  expect(command.request).toMatchObject({ kind: 'command', command: 'printf "{{literal}}"' });
  expect(summary.request).toMatchObject({ prompt: expect.stringContaining('responses without using tools: []') });
  const completion = service.getRun(id).signals.find(signal => signal.ref.stepId === 'research' && signal.ref.signal === 'turn_completed')!;
  expect(completion).not.toHaveProperty('payload');
  expect(step(service, id, 'needs_text').instances[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('complete signal payload') });
  command.finish({ kind: 'succeeded' });
  summary.finish(success('No findings.'));
  await until(() => service.getRun(id).status === 'attention');
});

test('retries only a known failure with a fresh chat and retains its prior signal identities', async () => {
  const { service, runner } = workspace()();
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const initial = await runner.next('research');
  const receipt = initial.callbacks.emit(finding('F1'));
  const verifier = await runner.next('verify');
  verifier.finish(success('verdict'));
  initial.finish({ kind: 'failed', reason: 'Definite synthetic failure' });
  await until(() => step(service, id, 'research').instances[0]?.status === 'failed');
  expect(step(service, id, 'summary').waitingReason).toContain('producer needs attention');
  expect(() => initial.callbacks.emit(finding('late'))).toThrow('no live turn');
  const retry = { runId: id, instanceId: initial.request.instanceId, operationId: 'retry-1' };
  expect(service.retry(retry, ACTOR)).toEqual(service.retry(retry, ACTOR));
  const second = await runner.next('research', 1);
  expect(second.chatId).not.toBe(initial.chatId);
  expect(second.request).toMatchObject({ instanceId: initial.request.instanceId, attemptNumber: 2 });
  expect(second.callbacks.emit(finding('F1'))).toEqual(receipt);
  second.finish(success('research completed'));
  await runner.next('summary');
  expect(step(service, id, 'verify').instances).toHaveLength(1);
  expect(step(service, id, 'research').instances[0]?.attempts).toMatchObject([
    { id: initial.request.attemptId, status: 'failed' }, { id: second.request.attemptId, status: 'succeeded' },
  ]);
});

test('restart holds in-flight work unknown without replay but runs persisted independent ready work', async () => {
  const open = workspace();
  const first = open(new ControlledRunner(), { maxConcurrent: 1 });
  publish(first.service);
  await first.service.start();
  const { id } = first.service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await first.runner.next('research');
  const accepted = research.callbacks.emit(finding('F1'));
  expect(step(first.service, id, 'verify').instances[0]?.status).toBe('ready');
  first.service.close();

  const second = open();
  await second.service.start();
  const verifier = await second.runner.next('verify');
  expect(second.service.getRun(id).signals).toEqual([accepted]);
  expect(step(second.service, id, 'research').instances[0]).toMatchObject({ status: 'unknown', attempts: [{ chatId: research.chatId }] });
  expect(() => second.service.retry({ runId: id, instanceId: research.request.instanceId, operationId: 'unknown-retry' }, ACTOR)).toThrow('definitively failed');
  verifier.finish(success('verified'));
  await until(() => second.service.getRun(id).status === 'attention');
  expect(step(second.service, id, 'verify').intake).toBe('open');
  expect(step(second.service, id, 'summary').instances).toEqual([]);
  expect(second.runner.attempts.map(attempt => attempt.request.stepId)).toEqual(['verify']);
});

test('appends a single evidence-backed step and a future listener without replay or a revision edit', async () => {
  const { service, runner } = workspace()();
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  const evidence = research.callbacks.emit(finding('F1'));
  const request = { runId: id, operationId: 'add-selected', evidenceSignalId: evidence.id,
    source: 'id: selected\nkind: decision\nprompt: "Examine {{claim}}"\nbindings: {claim: signal.claim}\nchoices: {done: Done}\n' };
  const amendment = service.addStep(request, ACTOR);
  expect(service.addStep(request, ACTOR)).toEqual(amendment);
  expect(() => service.addStep({ ...request, operationId: 'missing', evidenceSignalId: 'fictional' }, ACTOR)).toThrow('not found');
  expect(step(service, id, 'selected').instances).toMatchObject([
    { trigger: { kind: 'signal', signalId: evidence.id }, prompt: 'Examine Synthetic claim' },
  ]);
  service.addStep({
    runId: id, operationId: 'add-future',
    source: 'id: future\nkind: decision\nprompt: "Review {{claim}}"\nbindings: { claim: signal.claim }\non: {kind: each, signal: research.finding_ready}\nchoices: {done: Done}\n',
  }, ACTOR);
  expect(step(service, id, 'future').instances).toEqual([]);
  research.callbacks.emit(finding('F1'));
  expect(step(service, id, 'future').instances).toEqual([]);
  research.callbacks.emit(finding('F2', 'Future claim'));
  expect(step(service, id, 'future').instances).toMatchObject([{ key: 'F2', prompt: 'Review Future claim' }]);
  expect(service.getRun(id).amendments).toHaveLength(2);
  expect(service.getRevision('research').definition.steps.map(step => step.id)).toEqual(['research', 'verify', 'summary', 'decide']);
  expect(step(service, id, 'verify').instances.map(instance => instance.key)).toEqual(['F1', 'F2']);
});

test('rolls back both signal and eligible instance when the write does not commit', async () => {
  const open = workspace();
  let fail = false;
  const first = open(new ControlledRunner(), {}, () => { if (fail) throw new Error('Synthetic commit failure'); });
  publish(first.service);
  await first.service.start();
  const { id } = first.service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await first.runner.next('research');
  fail = true;
  expect(() => research.callbacks.emit(finding('F1'))).toThrow('Workflow storage is unavailable');
  first.service.close();
  const second = open();
  await second.service.start();
  expect(second.service.getRun(id).signals).toEqual([]);
  expect(step(second.service, id, 'verify').instances).toEqual([]);
  expect(step(second.service, id, 'research').instances[0]?.status).toBe('unknown');
});

test('snapshots and protects executor/provider references, waits for exact executor readiness, and fences a deleted chat', async () => {
  let model = 'initial';
  const guarded: string[][] = [];
  const { service, runner } = workspace()(new ControlledRunner(false), {
    snapshotAgentSettings: () => ({ model, apiProviderId: 'synthetic-provider', providerRevision: 7 }),
    retainExecutorReferences: ids => { guarded.push(ids.flatMap(id => id ? [id] : [])); return () => {}; },
    retainProviderReferences: ids => { guarded.push(ids.flatMap(id => id ? [id] : [])); return () => {}; },
  });
  const source = `version: 1
name: Exact location
steps:
  - id: remote
    kind: agent
    executorId: ${REMOTE}
    prompt: Perform the synthetic task.
  - id: local
    kind: command
    command: echo independent
`;
  publish(service, source);
  expect(service.referencesExecutor(REMOTE)).toBe(false);
  expect(() => service.startRun({ definitionId: 'research', inputs: {}, executionContext: LOCAL })).toThrow('requires a folder');
  const { id } = service.startRun({ definitionId: 'research', inputs: {},
    executionContext: { ...LOCAL, projectPaths: { [REMOTE]: '/synthetic/remote' } } });
  model = 'changed';
  expect(guarded).toEqual([[REMOTE, 'local'], ['synthetic-provider']]);
  expect(service.referencesExecutor(REMOTE)).toBe(true);
  expect(service.referencesApiProvider('synthetic-provider')).toBe(true);
  await service.start();
  const remote = await runner.next('remote');
  expect(remote.request).toMatchObject({ location: { executorId: REMOTE, projectPath: '/synthetic/remote' },
    settings: { model: 'initial', apiProviderId: 'synthetic-provider', providerRevision: 7 } });
  const local = await runner.next('local');
  local.callbacks.attachChat(local.chatId, local.turnId);
  local.finish(success('local'));
  remote.finish({ kind: 'unavailable', reason: 'Awaiting remote executor' });
  await until(() => step(service, id, 'remote').instances[0]?.status === 'waiting-executor');
  service.wakeExecutor('local');
  await drain();
  expect(runner.attempts.filter(attempt => attempt.request.stepId === 'remote')).toHaveLength(1);
  service.wakeExecutor(REMOTE);
  const recovered = await runner.next('remote', 1);
  recovered.callbacks.attachChat(recovered.chatId, recovered.turnId);
  service.handleChatRemoved(recovered.chatId);
  expect(recovered.callbacks.signal.aborted).toBe(true);
  recovered.finish(success('late result'));
  await drain();
  expect(service.listActiveChats().items).toEqual([]);
  expect(step(service, id, 'remote').instances[0]).toMatchObject({
    status: 'unknown', attempts: [{ status: 'unavailable' }, { status: 'unknown', chatAvailable: false }],
  });
  expect(service.getRun(id).signals.map(signal => signal.ref.stepId)).toEqual(['local']);
});
