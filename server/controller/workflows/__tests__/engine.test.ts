import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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
import { WORKFLOW_SCHEMA } from '../schema.js';
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

  constructor(private readonly publishChat = true) {}

  run(request: WorkflowAttemptRequest, callbacks: WorkflowAttemptCallbacks): Promise<WorkflowAttemptResult> {
    const chatId = randomUUID();
    const turnId = randomUUID();
    if (this.publishChat) {
      callbacks.attachChat(chatId, turnId);
      callbacks.confirmChat();
    }
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

test('pre-reservation unavailability waits through repeated readiness changes without exhausting attempts', async () => {
  const { service, runner } = workspace()(new ControlledRunner(false));
  publish(service, 'version: 1\nname: Wait\nsteps: [{id: work, kind: command, command: pwd}]');
  const { id } = service.startRun({ definitionId: 'research', inputs: {}, executionContext: LOCAL });
  await service.start();
  for (let n = 0; n <= WORKFLOW_LIMITS.attemptsPerInstance; n++) {
    const call = await runner.next('work', n);
    call.finish({ kind: 'unavailable', reason: 'Reconnect the executor.' });
    await until(() => step(service, id, 'work').instances[0].status === 'waiting-executor');
    expect(step(service, id, 'work').instances[0]).toMatchObject({ attempts: [], reason: 'Reconnect the executor.' });
    service.wakeExecutor('local');
  }
  const admitted = await runner.next('work', WORKFLOW_LIMITS.attemptsPerInstance + 1);
  expect(admitted.request.attemptNumber).toBe(1);
  expect(new Set(runner.attempts.map(({ request }) => request.attemptId)).size).toBe(runner.attempts.length);
  admitted.callbacks.attachChat(admitted.chatId, admitted.turnId);
  admitted.finish({ kind: 'unavailable', reason: 'Unavailable after reservation' });
  await until(() => step(service, id, 'work').instances[0].status === 'waiting-executor');
  service.wakeExecutor('local');
  const next = await runner.next('work', WORKFLOW_LIMITS.attemptsPerInstance + 2);
  next.callbacks.attachChat(next.chatId, next.turnId);
  next.callbacks.confirmChat();
  next.finish(success('Complete'));
  await until(() => service.getRun(id).status === 'succeeded');
  expect(step(service, id, 'work').instances[0].attempts).toMatchObject([{ number: 1, status: 'unavailable' }, { number: 2, status: 'succeeded' }]);
});

test('a completion-only join waits for every repeated human decision without requiring final text', async () => {
  const { service, runner } = workspace()();
  const source = `version: 1
name: Join decisions
steps:
  - {id: producer, kind: agent, prompt: Report, signals: {item: {delivery: many, payload: json, fields: {id: string}, key: id}}}
  - {id: review, kind: decision, prompt: Pick, choices: {ok: Accept}, on: {kind: each, signal: producer.item}}
  - {id: finish, kind: command, command: pwd, on: {kind: all, close: producer.turn_completed, steps: [review]}}
`;
  publish(service, source);
  const { id } = service.startRun({ definitionId: 'research', inputs: {}, executionContext: LOCAL });
  await service.start();
  const producer = await runner.next('producer');
  producer.callbacks.emit({ signal: 'item', payload: { id: 'item-1' } });
  producer.finish(success('Reported'));
  await until(() => step(service, id, 'producer').instances[0].status === 'succeeded');
  expect(step(service, id, 'finish').instances).toHaveLength(0);
  service.decide({ runId: id, instanceId: step(service, id, 'review').instances[0].id, choice: 'ok', operationId: 'approve' }, ACTOR);
  (await runner.next('finish')).finish(success('Complete'));
  await until(() => service.getRun(id).status === 'succeeded');
});

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
  let nested: unknown = null;
  for (let level = 0; level < 33; level++) nested = [nested];
  expect(() => service.startRun({ definitionId: 'research', inputs: { title: 'test', extra: nested } })).toThrow('JSON size limit');
  expect(() => service.startRun({
    definitionId: 'research', inputs: { title: 'test' }, executionContext: { defaultTarget: { executorId: 'bogus', projectPath: '/test' } },
  })).toThrow('valid executor id');
  const start = { definitionId: 'research', inputs: { title: 'Synthetic' }, operationId: 'launch-1' };
  expect(service.replayStartRun(start)).toBeNull();
  const prepared = service.getRevision(start.definitionId);
  expect(() => publish(service, source)).toThrow('published workflow changed');
  const revised = source.replace('name: Example', 'name: Later');
  const latest = publish(service, revised, 'research', 1);
  expect(latest).toMatchObject({ revision: 2, source: revised });
  expect(() => service.startRun({ ...start, revision: 2 }, undefined, prepared)).toThrow('prepared revision does not match');
  expect(() => service.startRun(start, undefined, { ...prepared, definitionId: 'wrong' })).toThrow('prepared revision does not match');
  const first = service.startRun(start, undefined, prepared);
  expect(service.replayStartRun(start)).toEqual(first);
  expect(service.startRun(start).id).toBe(first.id);
  expect(service.startRun(start, undefined, latest).id).toBe(first.id);
  const changed = { ...start, inputs: { title: 'Different' } };
  expect(() => service.replayStartRun(changed)).toThrow('different launch');
  expect(() => service.startRun(changed)).toThrow('different launch');

  const testRequest = { source, inputs: { title: 'Draft' }, operationId: 'draft-1' };
  expect(service.replayTestWorkflowDraft(testRequest)).toBeNull();
  const draft = service.testWorkflowDraft(testRequest, parsed(source));
  expect(service.replayTestWorkflowDraft(testRequest)).toEqual(draft);
  expect(() => service.replayTestWorkflowDraft({ ...testRequest, source: revised })).toThrow('different launch');
  expect(() => service.replayTestWorkflowDraft({ ...testRequest, operationId: start.operationId })).toThrow('different launch');
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
  expect(service.replayStartRun(start)).toEqual(first);
  expect(service.startRun(start, undefined, prepared)).toEqual(first);
  expect(service.getRun(first.id).pinnedRevision.source).toBe(source);
});

test('stores and dispatches one scoped signal instruction block without changing authored source', async () => {
  const { service, runner } = workspace()();
  const source = `version: 1
name: Prompt instructions
inputs:
  topic: {type: string}
  context: {type: string, default: "resolved"}
steps:
  - id: produce
    kind: agent
    prompt: "Review {{topic}} with {{context}}."
    bindings: {topic: inputs.topic, context: inputs.context}
    signals:
      ready: {payload: none}
      report: {payload: text}
      totals: {payload: json, fields: {count: number}}
      finding:
        payload: json
        delivery: many
        key: id
        fields: {id: string, verified: boolean, evidence: json}
  - id: independent
    kind: agent
    prompt: Run independently.
    signals:
      other: {payload: none}
  - id: plain
    kind: agent
    prompt: Agent without signals.
    signals: {}
  - id: literal
    kind: command
    command: 'printf "{{literal}}"'
  - id: person
    kind: decision
    prompt: "Confirm {{context}}."
    bindings: {context: inputs.context}
    choices: {confirm: Confirm}
`;
  publish(service, source);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: '{{context}}' }, executionContext: LOCAL });
  const produced = await runner.next('produce');
  const saved = step(service, id, 'produce');
  const prompt = saved.instances[0]!.prompt!;
  expect(produced.request).toMatchObject({ kind: 'agent', prompt });
  expect(prompt).toStartWith('Review {{context}} with resolved.\n\nGarcon workflow signals\n');
  expect(prompt).toContain('standalone raw tags in assistant output');
  expect(prompt).toContain('Never emit via Shell or tools.');
  expect(prompt).toContain('Never emit turn_completed');
  expect(prompt).toContain('produce.ready (none, once)\n<garcon-workflow-emit signal="produce.ready" content-type="none" />');
  expect(prompt).toContain('produce.report (text, once)\n<garcon-workflow-emit signal="produce.report" content-type="text">TEXT_PAYLOAD</garcon-workflow-emit>');
  expect(prompt).toContain('produce.totals (json, once; required fields: count: number)');
  expect(prompt).toContain('produce.finding (json, many; key: id; required fields: id: string, verified: boolean, evidence: json)');
  expect(prompt).toContain('<garcon-workflow-emit signal="produce.finding" content-type="json">JSON_PAYLOAD</garcon-workflow-emit>');
  expect(Array.from(prompt.matchAll(/<garcon-workflow-emit signal="([^"]+)"/gu), match => match[1]))
    .toEqual(['produce.ready', 'produce.report', 'produce.totals', 'produce.finding']);
  expect(saved.step).toMatchObject({ prompt: 'Review {{topic}} with {{context}}.' });
  expect(service.getRun(id).pinnedRevision.source).toBe(source);

  const independent = await runner.next('independent');
  expect(independent.request).toMatchObject({ prompt: expect.stringContaining('independent.other') });
  expect(independent.request).not.toMatchObject({ prompt: expect.stringContaining('produce.finding') });
  expect((await runner.next('plain')).request).toMatchObject({ prompt: 'Agent without signals.' });
  expect((await runner.next('literal')).request).toMatchObject({ command: 'printf "{{literal}}"' });
  expect(step(service, id, 'person').instances[0]?.prompt).toBe('Confirm resolved.');

  produced.finish({ kind: 'failed', reason: 'Synthetic failure.' });
  await until(() => step(service, id, 'produce').instances[0]?.status === 'failed');
  service.retry({ runId: id, instanceId: produced.request.instanceId, operationId: 'retry-prompt' }, ACTOR);
  expect((await runner.next('produce', 1)).request).toMatchObject({ prompt });
});

test('signal instructions count toward the rendered prompt limit', () => {
  const { service } = workspace()();
  const source = `version: 1
name: Prompt limit
inputs: {chunk: {type: string}}
steps:
  - id: plain
    kind: agent
    prompt: "{{chunk}}{{chunk}}"
    bindings: {chunk: inputs.chunk}
  - id: emitter
    kind: agent
    prompt: "{{chunk}}{{chunk}}"
    bindings: {chunk: inputs.chunk}
    signals: {ready: {payload: none}}
`;
  publish(service, source);
  const chunk = 'a'.repeat(WORKFLOW_LIMITS.promptBytes / 2 - 64);
  const { id } = service.startRun({ definitionId: 'research', inputs: { chunk }, executionContext: LOCAL });
  expect(step(service, id, 'plain').instances[0]).toMatchObject({ status: 'ready', prompt: chunk + chunk });
  expect(step(service, id, 'emitter').instances[0]).toMatchObject({
    status: 'blocked', prompt: null, reason: 'Rendered prompt exceeds the size limit.',
  });
});

test('signal instructions count toward the persisted run binding budget', () => {
  const { service } = workspace()();
  const count = WORKFLOW_LIMITS.steps;
  const source = 'version: 1\nname: Run binding limit\ninputs: {chunk: {type: string}}\nsteps:\n'
    + Array.from({ length: count }, (_, index) => `  - id: step-${index}
    kind: agent
    prompt: "{{chunk}}"
    bindings: {chunk: inputs.chunk}
${index === count - 1 ? '    signals: {ready: {payload: none}}\n' : ''}`).join('');
  publish(service, source);
  const plainBytes = Math.floor(WORKFLOW_LIMITS.bindingBytesPerRun / count);
  const chunk = 'a'.repeat(Math.floor((plainBytes - Buffer.byteLength('{"chunk":""}')) / 2) - 1);
  const { id } = service.startRun({ definitionId: 'research', inputs: { chunk }, executionContext: LOCAL });
  const steps = service.getRun(id).steps;
  expect(steps.slice(0, -1).every(step => step.instances[0]?.status === 'ready')).toBe(true);
  expect(steps.at(-1)?.instances[0]).toMatchObject({
    status: 'blocked', prompt: null, reason: 'Run has reached its bound input storage limit.',
  });
});

test('schedules keyed signals early, respects running limits, includes queued manual items, and holds for an attributed decision', async () => {
  const { service, runner } = workspace()();
  publish(service, RESEARCH.replace('maxConcurrency: 2', 'maxConcurrency: 1'));
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  const f1 = research.callbacks.emit(finding('F1'));
  expect(step(service, id, 'research').instances[0]?.trigger).toEqual({ kind: 'root' });
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
  expect(step(service, id, 'verify').instances.find(item => item.key === 'manual')?.trigger)
    .toEqual({ kind: 'signal', signalId: manual.id });
  expect(service.addItem(add, ACTOR).id).toBe(manual.id);
  expect(manual.source).toEqual({ kind: 'manual', actor: ACTOR, operationId: 'manual-1' });
  expect(() => service.addItem({ ...add, key: 'changed' }, ACTOR)).toThrow('different request');
  expect(() => research.callbacks.emit(finding('manual'))).toThrow('already has a manual item');
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
  const close = service.getRun(id).signals.find(item => item.ref.stepId === 'research' && item.ref.signal === 'turn_completed')!;
  expect(step(service, id, 'summary').instances[0]?.trigger).toEqual({ kind: 'join', closeSignalId: close.id });
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
  expect(() => command.callbacks.emit({ signal: 'report_ready', payload: 'not an authorized emit' })).toThrow('does not declare');
  expect(summary.request).toMatchObject({ prompt: expect.stringContaining('responses without using tools: []') });
  const completion = service.getRun(id).signals.find(signal => signal.ref.stepId === 'research' && signal.ref.signal === 'turn_completed')!;
  expect(completion).not.toHaveProperty('payload');
  expect(step(service, id, 'needs_text').instances[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('complete signal payload') });
  expect(() => service.addStep({ runId: id, operationId: 'select-gap', evidenceSignalId: completion.id,
    source: 'id: rejected\nkind: decision\nprompt: "{{response}}"\nbindings: {response: signal}\nchoices: {done: Done}\n',
  }, ACTOR)).toThrow('complete signal payload');
  expect(service.getRun(id).amendments).toEqual([]);
  command.finish({ kind: 'succeeded' });
  summary.finish(success('No findings.'));
  await until(() => service.getRun(id).status === 'attention');
});

test('requires every sealed item to succeed and blocks a join binding on incomplete verifier output', async () => {
  const { service, runner } = workspace()();
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  research.callbacks.emit(finding('F1'));
  const verifier = await runner.next('verify');
  verifier.finish({ kind: 'failed', reason: 'Definite verification failure' });
  research.finish(success('closed'));
  await until(() => service.getRun(id).status === 'attention');
  expect(step(service, id, 'verify').intake).toBe('closed');
  expect(step(service, id, 'summary')).toMatchObject({ instances: [], waitingReason: expect.stringContaining('need attention') });
  service.retry({ runId: id, instanceId: verifier.request.instanceId, operationId: 'known-retry' }, ACTOR);
  const retried = await runner.next('verify', 1);
  retried.finish({ kind: 'succeeded', output: { kind: 'incomplete' } });
  await until(() => step(service, id, 'summary').instances[0]?.status === 'blocked');
  expect(step(service, id, 'summary').instances[0]?.reason).toContain('without complete final output');
  expect(runner.attempts.map(attempt => attempt.request.stepId)).toEqual(['research', 'verify', 'verify']);
});

test('rejects an over-limit emission without adding a signal or partially admitting its fan-out', async () => {
  const { service, runner } = workspace()(new ControlledRunner(), { maxConcurrent: 1 });
  publish(service, RESEARCH + `
  - id: repeat
    kind: decision
    on: { kind: each, signal: research.finding_ready }
    prompt: Inspect finding.
    choices: { done: Done }
`);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  service.addItem({ runId: id, stepId: 'verify', key: 'manual', payload: finding('manual').payload, operationId: 'manual-1' }, ACTOR);
  const accepted = WORKFLOW_LIMITS.repeatInstances / 2 - 1;
  for (let item = 0; item < accepted; item++) research.callbacks.emit(finding(`F${item}`));
  expect(() => research.callbacks.emit(finding('does-not-fit'))).toThrow('repeat item limit');
  const run = service.getRun(id);
  expect(run.signals).toHaveLength(accepted + 1);
  expect(run.steps.find(step => step.step.id === 'verify')?.instances).toHaveLength(accepted + 1);
  expect(run.steps.find(step => step.step.id === 'repeat')?.instances).toHaveLength(accepted);
});

test('retains the execution slot of a removed chat until the exact runner settles', async () => {
  const { service, runner } = workspace()();
  publish(service, RESEARCH.replace('maxConcurrency: 2', 'maxConcurrency: 1'));
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  research.callbacks.emit(finding('F1'));
  research.callbacks.emit(finding('F2'));
  const first = await runner.next('verify');
  service.handleChatRemoved(first.chatId);
  await drain();
  expect(runner.attempts.filter(attempt => attempt.request.stepId === 'verify')).toHaveLength(1);
  first.finish(success('late result'));
  await runner.next('verify', 1);
  const instance = step(service, id, 'verify').instances[0]!;
  expect(instance.status).toBe('unknown');
  expect(service.getRun(id).signals.some(signal => signal.instanceId === instance.id)).toBe(false);
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

test('never links a failed private start to the chat that collided with its reservation', async () => {
  const { service, runner } = workspace()(new ControlledRunner(false), { hasChat: () => true });
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'synthetic' }, executionContext: LOCAL });
  const research = await runner.next('research');
  expect(() => research.callbacks.confirmChat()).toThrow('no live chat reservation');
  research.callbacks.attachChat(research.chatId, research.turnId);
  expect(step(service, id, 'research').instances[0]?.attempts[0]).toMatchObject({
    status: 'running', chatId: null, turnId: null, chatAvailable: false,
  });
  expect(service.listActiveChats().items).toEqual([]);
  service.handleChatRemoved(research.chatId);
  expect(research.callbacks.signal.aborted).toBe(false);
  research.finish({ kind: 'failed', reason: 'CHAT_ID_COLLISION' });
  await until(() => step(service, id, 'research').instances[0]?.status === 'failed');
  expect(() => research.callbacks.confirmChat()).toThrow('no live chat reservation');
  expect(step(service, id, 'research').instances[0]?.attempts[0]).toMatchObject({
    status: 'failed', chatId: null, turnId: null, chatAvailable: false, reason: 'CHAT_ID_COLLISION',
  });
  expect(service.listActiveChats().items).toEqual([]);
});

test('a restart before reservation leaves a failed attempt for manual retry, without dispatching it', async () => {
  const open = workspace();
  const first = open(new ControlledRunner(false));
  publish(first.service);
  await first.service.start();
  const { id } = first.service.startRun({ definitionId: 'research', inputs: { topic: 'test' }, executionContext: LOCAL });
  const { request } = await first.runner.next('research');
  first.service.close();

  const next = open();
  await next.service.start();
  await drain();
  expect(next.runner.attempts).toHaveLength(0);
  expect(step(next.service, id, 'research').instances[0]).toMatchObject({
    status: 'failed', attempts: [{ status: 'failed', chatAvailable: false }],
  });
  next.service.retry({ runId: id, instanceId: request.instanceId, operationId: 'explicit-retry' }, ACTOR);
  expect((await next.runner.next('research')).request.attemptNumber).toBe(2);
});

test.each([false, true])('runner exception uses durable reservation evidence (reserved: %s)', async reserved => {
  const { service } = workspace()(new ControlledRunner(), {
    runner: { async run(_attempt, callbacks) {
      if (reserved) callbacks.attachChat('private-chat', 'private-turn');
      throw new Error('Synthetic interrupted admission');
    } },
  });
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'test' }, executionContext: LOCAL });
  await until(() => service.getRun(id).status === 'attention');
  expect(step(service, id, 'research').instances[0]?.status).toBe(reserved ? 'unknown' : 'failed');
});

test('restart between reservation and publication keeps the attempt unknown and unlinked', async () => {
  const open = workspace();
  const first = open(new ControlledRunner(false));
  publish(first.service);
  await first.service.start();
  const { id } = first.service.startRun({ definitionId: 'research', inputs: { topic: 'synthetic' }, executionContext: LOCAL });
  const research = await first.runner.next('research');
  research.callbacks.attachChat(research.chatId, research.turnId);
  first.service.close();

  const second = open(new ControlledRunner(), { hasChat: id => id === research.chatId });
  await second.service.start();
  await drain();
  expect(second.runner.attempts).toEqual([]);
  expect(second.service.listActiveChats().items).toEqual([]);
  expect(second.service.getRun(id).signals).toEqual([]);
  expect(step(second.service, id, 'research').instances[0]).toMatchObject({ status: 'unknown', attempts: [
    { status: 'unknown', chatId: null, turnId: null, chatAvailable: false, reason: expect.stringContaining('Check the chat list') },
  ] });
});

test('can record an authorized early signal before confirmation without publishing a chat link', async () => {
  const { service, runner } = workspace()(new ControlledRunner(false), { maxConcurrent: 1 });
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'synthetic' }, executionContext: LOCAL });
  const research = await runner.next('research');
  research.callbacks.attachChat(research.chatId, research.turnId);
  const accepted = research.callbacks.emit(finding('early'));
  expect(service.getRun(id).signals).toEqual([accepted]);
  expect(service.listActiveChats().items).toEqual([]);
  research.callbacks.confirmChat();
  research.callbacks.confirmChat();
  expect(step(service, id, 'research').instances[0]?.attempts[0]).toMatchObject({
    chatId: research.chatId, turnId: research.turnId, chatAvailable: true,
  });
  expect(service.listActiveChats().items).toMatchObject([{ chatId: research.chatId, attemptId: research.request.attemptId }]);
});

test('pages confirmed existing chats without spending visible slots on reservations, removals or missing chats', async () => {
  const existing = new Set(['chat-01', 'chat-03', 'chat-05', 'chat-06']);
  const { service, runner } = workspace()(new ControlledRunner(false), { maxConcurrent: 8, hasChat: id => existing.has(id) });
  const source = 'version: 1\nname: Chats\nsteps:\n' + Array.from({ length: 6 }, (_, index) => `  - id: work-${index + 1}
    kind: command
    command: synthetic
`).join('');
  publish(service, source);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: {}, executionContext: LOCAL });
  for (let index = 1; index <= 6; index++) {
    const attempt = await runner.next(`work-${index}`);
    const chatId = `chat-0${index}`;
    attempt.callbacks.attachChat(chatId, attempt.turnId);
    if (index >= 2) attempt.callbacks.confirmChat();
    if (index === 3) service.handleChatRemoved(chatId);
  }
  const first = service.listActiveChats({ limit: 1 });
  expect(first.items.map(row => row.chatId)).toEqual(['chat-05']);
  expect(first.nextCursor).toBe('chat-05');
  const next = service.listActiveChats({ limit: 1, cursor: first.nextCursor! });
  expect(next.items.map(row => row.chatId)).toEqual(['chat-06']);
  expect(next.nextCursor).toBeNull();
  expect(step(service, id, 'work-2').instances[0]?.attempts[0]).toMatchObject({ chatId: 'chat-02', chatAvailable: false });
  expect(step(service, id, 'work-3').instances[0]?.attempts[0]).toMatchObject({ chatId: 'chat-03', chatAvailable: false });
  expect(step(service, id, 'work-5').instances[0]?.attempts[0]).toMatchObject({ chatId: 'chat-05', chatAvailable: true });
});

test('migrates only proven published chats and never infers publication from unknown or failed outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'garcon-workflow-migration-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const source = 'version: 1\nname: Old schema\nsteps:\n  - id: worker\n    kind: command\n    command: synthetic\n';
  const definition = parsed(source);
  {
    using db = new Database(join(dir, 'workflow-runs.sqlite'));
    db.exec(WORKFLOW_SCHEMA);
    db.exec(`DROP INDEX workflow_attempts_active_chats;
      ALTER TABLE workflow_attempts DROP COLUMN chat_confirmed;
      CREATE INDEX workflow_attempts_active_chats ON workflow_attempts(chat_id)
        WHERE chat_id IS NOT NULL AND chat_removed = 0 AND status IN ('running', 'failed', 'unknown');
      PRAGMA user_version = 2;`);
    for (const [id, status] of [['proven', 'succeeded'], ['unproven', 'succeeded'], ['failed', 'failed'], ['unknown', 'unknown']]) {
      db.query(`INSERT INTO workflow_runs (id, name, draft_json, inputs_json, context_json, status, created_at, updated_at)
        VALUES (?, 'Old schema', ?, '{}', '{}', ?, 'created', 'updated')`).run(id,
        JSON.stringify({ definitionId: null, revision: null, source, definition, publishedAt: null }),
        status === 'succeeded' ? status : 'attention',
      );
      db.query(`INSERT INTO workflow_run_steps (run_id, id, step_json, max_concurrency, intake, added)
        VALUES (?, 'worker', ?, 1, 'closed', 0)`).run(id, JSON.stringify(definition.steps[0]));
      db.query(`INSERT INTO workflow_instances (id, run_id, step_id, trigger_json, is_repeated, status, attempt_count)
        VALUES (?, ?, 'worker', '{"kind":"root"}', 0, ?, 1)`).run(id, id, status);
      db.query(`INSERT INTO workflow_attempts (id, instance_id, number, status, chat_id, turn_id, started_at)
        VALUES (?, ?, 1, ?, ?, ?, 'started')`).run(id, id, status, `chat-${id}`, `turn-${id}`);
      if (id !== 'unproven') db.query(`INSERT INTO workflow_signals
        (id, run_id, step_id, instance_id, signal, key, scope, source_json, created_at)
        VALUES (?, ?, 'worker', ?, 'turn_completed', '', ?, ?, 'finished')`).run(id, id, id, id,
          JSON.stringify({ kind: 'completion', attemptId: id, chatId: `chat-${id}`, turnId: `turn-${id}` }),
        );
    }
  }
  const service = new WorkflowEngine({ store: new WorkflowStore(dir), runner: new ControlledRunner() });
  cleanups.push(() => service.close());
  expect(step(service, 'proven', 'worker').instances[0]?.attempts[0]).toMatchObject({ chatId: 'chat-proven', chatAvailable: true });
  for (const id of ['unproven', 'failed', 'unknown']) {
    expect(step(service, id, 'worker').instances[0]?.attempts[0]).toMatchObject({ chatId: null, turnId: null, chatAvailable: false });
  }
  expect(service.listActiveChats().items).toEqual([]);
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

test('archives only after live attempts settle, preserving evidence while retiring work and releasing references', async () => {
  const create = workspace();
  const { service, runner } = create(new ControlledRunner(), {
    snapshotAgentSettings: () => ({ apiProviderId: 'synthetic-provider' }),
  });
  publish(service, RESEARCH + `
  - id: choose
    kind: decision
    prompt: Proceed?
    choices: {yes: Proceed}
`);
  const launch = { definitionId: 'research', inputs: { topic: 'synthetic' },
    executionContext: { defaultTarget: { executorId: REMOTE, projectPath: '/synthetic/remote' } } };
  await service.start();
  const { id } = service.startRun(launch);
  const request = { runId: id, operationId: 'archive-1' };
  const research = await runner.next('research');
  expect(() => service.archiveRun(request, ACTOR)).toThrow('live workflow attempt');
  expect(research.callbacks.signal.aborted).toBe(false);

  const receipt = research.callbacks.emit(finding('F1'));
  const manual = { runId: id, stepId: 'verify', key: 'human', payload: finding('human').payload, operationId: 'prior-item' };
  service.addItem(manual, ACTOR);
  const verifier = await runner.next('verify');
  const manualVerifier = await runner.next('verify', 1);
  research.finish({ kind: 'unknown', reason: 'Controller cannot prove an outcome.' });
  verifier.finish({ kind: 'failed', reason: 'Definite failure.' });
  manualVerifier.finish(success('verified'));
  await until(() => service.getRun(id).status === 'attention');
  const decision = step(service, id, 'choose').instances[0]!;
  const before = service.getRun(id);
  expect(service.referencesExecutor(REMOTE)).toBe(true);
  expect(service.referencesApiProvider('synthetic-provider')).toBe(true);
  expect(service.listActiveChats().items.map(chat => chat.status).sort()).toEqual(['failed', 'unknown']);
  expect(() => service.archiveRun({ ...request, operationId: manual.operationId }, ACTOR)).toThrow('different request');
  const archived = service.archiveRun(request, ACTOR);
  expect(archived.status).toBe('archived');
  expect(service.archiveRun(request, ACTOR)).toEqual(archived);
  expect(() => service.archiveRun(request, { id: 'another-person', name: 'Other person' })).toThrow('different request');
  expect(service.listRuns().items).toEqual([archived]);
  const after = service.getRun(id);
  expect(after).toMatchObject({ archive: { actor: ACTOR, operationId: request.operationId, createdAt: archived.updatedAt } });
  expect(after.steps).toEqual(before.steps);
  expect(after.signals).toEqual(before.signals);
  expect(after.signals).toContainEqual(receipt);
  expect(after.amendments).toEqual(before.amendments);
  expect(service.referencesExecutor(REMOTE)).toBe(false);
  expect(service.referencesApiProvider('synthetic-provider')).toBe(false);
  expect(service.listActiveChats().items).toEqual([]);
  expect(() => service.retry({ runId: id, instanceId: verifier.request.instanceId, operationId: 'retry' }, ACTOR)).toThrow('run is archived');
  expect(() => service.decide({ runId: id, instanceId: decision.id, operationId: 'decision', choice: 'yes' }, ACTOR)).toThrow('run is archived');
  expect(() => service.addItem({ ...manual, operationId: 'late' }, ACTOR)).toThrow('run is archived');
  expect(() => service.addStep({ runId: id, operationId: 'amend', source: 'id: late' }, ACTOR)).toThrow('run is archived');
  expect(service.addItem(manual, ACTOR)).toEqual(before.signals.find(signal => signal.key === 'human')!);

  const queued = service.startRun(launch);
  service.archiveRun({ runId: queued.id, operationId: 'archive-queued' }, ACTOR);
  service.close();
  const restored = create();
  restored.service.wakeExecutor(REMOTE);
  await restored.service.start();
  await drain();
  expect(restored.service.getRun(id)).toEqual(after);
  expect(restored.service.getRun(queued.id).status).toBe('archived');
  expect(step(restored.service, queued.id, 'research').instances[0]).toMatchObject({ status: 'ready', attempts: [] });
  expect(restored.runner.attempts).toEqual([]);
});

test('appends a single evidence-backed step and a future listener without replay or a revision edit', async () => {
  const { service, runner } = workspace()();
  publish(service);
  await service.start();
  const { id } = service.startRun({ definitionId: 'research', inputs: { topic: 'toy geometry' }, executionContext: LOCAL });
  const research = await runner.next('research');
  const evidence = research.callbacks.emit(finding('F1'));
  research.callbacks.emit({ signal: 'research_started' });
  const listen = (signal: string) => service.addStep({ runId: id, operationId: 'add-unreachable',
    source: `id: unreachable\nkind: command\ncommand: "true"\non: {kind: once, signal: research.${signal}}\n`,
  }, ACTOR);
  expect(() => listen('research_started')).toThrow('can no longer emit');
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
  research.finish(success('finished'));
  await until(() => step(service, id, 'research').instances[0]?.status === 'succeeded');
  expect(() => listen('report_ready')).toThrow('can no longer emit');
  expect(service.getRun(id).amendments).toHaveLength(2);
});

test('charges authored and resolved step bytes against one persisted run budget', () => {
  const open = workspace();
  const { service } = open();
  const source = 'version: 1\nname: Bounds\nsteps:\n  - id: hold\n    kind: decision\n    prompt: Hold\n    choices: {done: Done}\n';
  const { id } = service.testWorkflowDraft({ source, inputs: {}, executionContext: LOCAL }, parsed(source));
  const payload = '\u00e9'.repeat(120 * 1024);
  const addition = (index: number) => ({
    runId: id, operationId: `op-${index}`,
    source: `id: addition-${index}
kind: agent
agentId: codex
prompt: Synthetic test
agentSettings:
  ownerId: codex
  schemaVersion: 1
  values:
    synthetic: ${payload}
`,
  });
  const first = service.addStep(addition(1), ACTOR);
  for (let index = 2; index <= 4; index++) service.addStep(addition(index), ACTOR);
  service.close();

  const restored = open().service;
  expect(restored.addStep(addition(1), ACTOR)).toEqual(first);
  expect(() => restored.addStep(addition(5), ACTOR)).toThrow('saved step data size limit');
  expect(restored.getRun(id).steps.map(step => step.step.id)).toEqual(['hold', 'addition-1', 'addition-2', 'addition-3', 'addition-4']);
  expect(restored.getRun(id).amendments).toHaveLength(4);
  expect(restored.addStep({ ...addition(5),
    source: 'id: addition-5\nkind: decision\nprompt: Small\nchoices: {done: Done}\n',
  }, ACTOR)).toMatchObject({ kind: 'add-step', stepId: 'addition-5' });
});

test('rolls back a launch when its resolved captures exceed the step data budget', () => {
  const { service } = workspace()();
  publish(service);
  const request = { definitionId: 'research', inputs: { topic: 'synthetic' }, executionContext: LOCAL, operationId: 'budgeted-launch' };
  const payload = 'x'.repeat(768 * 1024);
  expect(() => service.startRun(request, () => ({
    agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { synthetic: payload } },
  }))).toThrow('saved step data size limit');
  expect(service.listRuns().items).toEqual([]);
  expect(service.replayStartRun(request)).toBeNull();
  expect(service.startRun(request).revision).toBe(1);
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
  let defaultResolutions = 0;
  const guarded: string[][] = [];
  const { service, runner } = workspace()(new ControlledRunner(false), {
    snapshotAgentSettings: () => { defaultResolutions++; return {}; },
    retainExecutorReferences: ids => { guarded.push(ids.flatMap(id => id ? [id] : [])); return () => {}; },
    retainProviderReferences: ids => { guarded.push(ids.flatMap(id => id ? [id] : [])); return () => {}; },
  });
  const source = `version: 1
name: Exact location
steps:
  - id: remote
    kind: agent
    executorId: ${REMOTE}
    model: model-alias
    apiProviderId: provider-alias
    modelEndpointId: endpoint-alias
    permissionMode: default
    attachments: [{ path: ./reference.txt }]
    tags: [synthetic-step]
    prompt: Perform the synthetic task.
  - id: local
    kind: command
    command: echo independent
`;
  publish(service, source);
  expect(service.referencesExecutor(REMOTE)).toBe(false);
  expect(() => service.startRun({ definitionId: 'research', inputs: {}, executionContext: LOCAL })).toThrow('requires a folder');
  const { id } = service.startRun({ definitionId: 'research', inputs: {},
    executionContext: { ...LOCAL, projectPaths: { [REMOTE]: '/synthetic/remote' } } },
  () => ({ model, apiProviderId: 'synthetic-provider', modelEndpointId: 'canonical-endpoint', modelProtocol: 'openai-compatible',
    providerRevision: 7, permissionMode: undefined, tags: ['resolver-tag'], attachments: [] }));
  model = 'changed';
  expect(guarded).toEqual([[REMOTE, 'local'], ['synthetic-provider']]);
  expect(service.referencesExecutor(REMOTE)).toBe(true);
  expect(service.referencesApiProvider('synthetic-provider')).toBe(true);
  expect(service.referencesApiProvider('provider-alias')).toBe(false);
  await service.start();
  const remote = await runner.next('remote');
  expect(remote.request).toMatchObject({ location: { executorId: REMOTE, projectPath: '/synthetic/remote' },
    settings: { model: 'initial', apiProviderId: 'synthetic-provider', modelEndpointId: 'canonical-endpoint', modelProtocol: 'openai-compatible',
      providerRevision: 7, permissionMode: 'default', tags: ['synthetic-step'], attachments: [{ path: './reference.txt' }] } });
  const local = await runner.next('local');
  local.callbacks.attachChat(local.chatId, local.turnId);
  local.callbacks.confirmChat();
  local.finish(success('local'));
  remote.finish({ kind: 'unavailable', reason: 'Awaiting remote executor' });
  await until(() => step(service, id, 'remote').instances[0]?.status === 'waiting-executor');
  service.wakeExecutor('local');
  await drain();
  expect(runner.attempts.filter(attempt => attempt.request.stepId === 'remote')).toHaveLength(1);
  service.wakeExecutor(REMOTE);
  const recovered = await runner.next('remote', 1);
  expect(defaultResolutions).toBe(0);
  expect(recovered.request).toMatchObject({ settings: { model: 'initial', modelProtocol: 'openai-compatible' } });
  recovered.callbacks.attachChat(recovered.chatId, recovered.turnId);
  recovered.callbacks.confirmChat();
  service.handleChatRemoved(recovered.chatId);
  expect(recovered.callbacks.signal.aborted).toBe(true);
  recovered.finish(success('late result'));
  await drain();
  expect(service.listActiveChats().items).toEqual([]);
  expect(step(service, id, 'remote').instances[0]).toMatchObject({
    status: 'unknown', attempts: [{ status: 'unknown', chatAvailable: false }],
  });
  expect(service.getRun(id).signals.map(signal => signal.ref.stepId)).toEqual(['local']);
});

test('cooperative stop signals only stopSignal on running attempts, blocks pending intakes on run stop, and prevents retrying stopped decisions', async () => {
  const { service, runner } = workspace()(new ControlledRunner());
  const source = `version: 1
name: Cooperative stop
steps:
  - { id: first, kind: command, command: sleep 30 }
  - { id: downstream, kind: command, on: { kind: once, signal: first.turn_completed }, command: echo done }
  - { id: check, kind: decision, prompt: Proceed?, choices: { ok: OK } }
`;
  publish(service, source, 'stop-def');
  const { id } = service.startRun({ definitionId: 'stop-def', inputs: {}, executionContext: LOCAL });
  await service.start();
  const first = await runner.next('first');
  expect(first.callbacks.signal.aborted).toBe(false);
  expect(first.callbacks.stopSignal?.aborted).toBe(false);

  service.stopRun({ runId: id, instanceId: first.request.instanceId, operationId: 'stop-first' }, ACTOR);
  expect(first.callbacks.signal.aborted).toBe(false);
  expect(first.callbacks.stopSignal?.aborted).toBe(true);
  first.finish({ kind: 'failed', reason: 'Stopped by user.' });
  await until(() => step(service, id, 'first').instances[0]?.status === 'failed');

  // Step stop keeps downstream intake open for retry.
  service.retry({ runId: id, instanceId: first.request.instanceId, operationId: 'retry-first' }, ACTOR);
  const retried = await runner.next('first', 1);
  service.stopRun({ runId: id, operationId: 'stop-whole-run' }, ACTOR);
  service.stopRun({ runId: id, operationId: 'stop-whole-run' }, ACTOR);
  expect(retried.callbacks.stopSignal?.aborted).toBe(true);
  retried.finish(success('late finish'));
  await until(() => service.getRun(id).status === 'attention');

  const after = service.getRun(id);
  expect(step(service, id, 'downstream').instances).toEqual([]);
  expect(step(service, id, 'downstream')).toMatchObject({
    intake: 'closed',
    waitingReason: 'Stopped by Example Reader.',
  });
  const decision = step(service, id, 'check').instances[0]!;
  expect(decision.status).toBe('blocked');
  expect(() => service.retry({ runId: id, instanceId: decision.id, operationId: 'retry-decision' }, ACTOR))
    .toThrow('cannot be retried');
  expect(after.status).toBe('attention');
});
