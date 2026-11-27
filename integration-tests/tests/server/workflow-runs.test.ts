import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveExecutorId, LOCAL_EXECUTOR_ID, type ExecutorSnapshot } from '../../../common/executors.js';
import { CODEX_MODELS } from '../../../common/models.js';
import { workflowPaths } from '../../../common/workflow-http.js';
import type {
  WorkflowActiveChat, WorkflowAddStepRequest, WorkflowDecisionRequest, WorkflowPage,
  WorkflowPublishRequest, WorkflowRetryRequest, WorkflowRevision, WorkflowRunDetail,
  WorkflowRunSummary, WorkflowStartRequest, WorkflowStepInstance,
} from '../../../common/workflow-runs.js';
import { withTimeout } from '../../support/deferred.js';
import {
  codexAssistantMessage, codexExecCommandCall, codexFinalAnswerMessage, type FakeCodexModel,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

const shellSource = `version: 1
name: Synthetic release review
inputs:
  label: { type: string }
  copies: { type: number, default: 2 }
  preview: { type: boolean, default: false }
steps:
  - id: produce
    kind: command
    shell: sh
    command: |-
      printf 'produce\\n' >> executions.log
      printf 'Synthetic complete stdout'
      printf 'Synthetic stderr' >&2
  - id: review
    kind: decision
    on: { kind: once, signal: produce.turn_completed }
    bindings: { report: signal, label: inputs.label, copies: inputs.copies, preview: inputs.preview }
    prompt: "Review {{label}} ({{copies}} copies, preview {{preview}}): {{report}}"
    choices: { approve: Approve, reject: Reject }
  - id: finish
    kind: command
    shell: sh
    on: { kind: once, signal: review.approve }
    command: |-
      printf 'finish\\n' >> executions.log
      printf 'Synthetic approved'
`;

const truncatedSource = `version: 1
name: Synthetic truncated output
steps:
  - id: produce
    kind: command
    shell: sh
    command: |-
      printf 'produce\\n' >> executions.log
      printf '%70000s' x
  - id: review
    kind: decision
    on: { kind: once, signal: produce.turn_completed }
    bindings: { report: signal }
    prompt: "Review {{report}}"
    choices: { approve: Approve }
  - id: acknowledge
    kind: decision
    on: { kind: once, signal: produce.turn_completed }
    prompt: Acknowledge that the process exited successfully.
    choices: { confirm: Confirm }
`;

const evidenceReview = `id: evidence-review
kind: decision
bindings: { report: signal }
prompt: "Check this stored evidence: {{report}}"
choices: { confirm: Confirm evidence }
`;

const researchSource = `version: 1
name: Synthetic finding verification
inputs:
  topic: { type: string }
steps:
  - id: research
    kind: agent
    agentId: codex
    model: ${CODEX_MODELS.DEFAULT}
    thinkingMode: low
    bindings: { topic: inputs.topic }
    prompt: "Research {{topic}}."
    signals:
      finding_ready:
        payload: json
        delivery: many
        key: finding_id
        fields: { finding_id: string, claim: string, evidence: string }
  - id: verify
    kind: agent
    agentId: codex
    model: ${CODEX_MODELS.DEFAULT}
    thinkingMode: low
    on: { kind: each, signal: research.finding_ready, maxConcurrency: 2 }
    bindings: { finding_id: signal.finding_id, claim: signal.claim, evidence: signal.evidence }
    prompt: "Verify {{finding_id}}: {{claim}} Evidence: {{evidence}}"
  - id: summary
    kind: agent
    agentId: codex
    model: ${CODEX_MODELS.DEFAULT}
    thinkingMode: low
    on: { kind: all, close: research.turn_completed, steps: [verify] }
    bindings: { verifications: all.verify }
    prompt: "Summarize verifications: {{verifications}}"
`;

const topic = 'synthetic geometry';
const findings = [
  { finding_id: 'F-01', claim: 'A triangle has three sides.', evidence: 'Count its line segments.' },
  { finding_id: 'F-02', claim: 'A square has four sides.', evidence: 'Count its equal edges.' },
  { finding_id: 'F-03', claim: 'A pentagon has five sides.', evidence: 'Count its vertices.' },
] as const;

function findingEmit(finding: { finding_id: string; claim: string; evidence: string }) {
  return `<garcon-workflow-emit signal="research.finding_ready" content-type="json">${JSON.stringify(finding)}</garcon-workflow-emit>`;
}

function holdResearch(model: FakeCodexModel, emissions: readonly string[], final: string) {
  const toolCall = 'hold_research_turn';
  model.scriptTurnMatching('research prompt', request => request.lastUserText.includes(`Research ${topic}.`)
    && !request.functionCallOutputs.some(output => output.callId === toolCall), [
    { ...codexAssistantMessage(emissions.join('\n\n')), phase: 'commentary' },
    codexExecCommandCall(toolCall, 'printf synthetic-research-progress'),
  ]);
  return model.scriptHeldTurnMatching('research terminal response',
    request => request.functionCallOutputs.some(output => output.callId === toolCall), [codexFinalAnswerMessage(final)]);
}

function verifierPrompt(finding: typeof findings[number]) {
  return `Verify ${finding.finding_id}: ${finding.claim} Evidence: ${finding.evidence}`;
}

const stepsOf = (run: WorkflowRunDetail) => run.steps.map(({ step }) => step.id);

function stepOf(run: WorkflowRunDetail, stepId: string) {
  const step = run.steps.find(({ step }) => step.id === stepId);
  if (!step) throw new Error(`No step "${stepId}" in run ${run.id}`);
  return step;
}

function onlyInstance(run: WorkflowRunDetail, stepId: string) {
  const { instances } = stepOf(run, stepId);
  expect(instances).toHaveLength(1);
  return instances[0]!;
}

function chatAttempt(instance: WorkflowStepInstance) {
  expect(instance.attempts).toHaveLength(1);
  const attempt = instance.attempts[0]!;
  if (!attempt.chatId || !attempt.turnId) throw new Error(`Attempt ${attempt.id} does not have a chat and turn`);
  return { ...attempt, chatId: attempt.chatId, turnId: attempt.turnId };
}

function publish(fixture: IntegrationFixture, source: string, definitionId = 'synthetic-acceptance') {
  return fixture.client.post<WorkflowRevision>(workflowPaths.definitions, {
    definitionId, expectedRevision: null, source,
  } satisfies WorkflowPublishRequest);
}

function launchRequest(fixture: IntegrationFixture, revision: WorkflowRevision, inputs: WorkflowStartRequest['inputs']): WorkflowStartRequest {
  if (!revision.definitionId || revision.revision === null) throw new Error('Expected a published revision');
  return {
    definitionId: revision.definitionId, revision: revision.revision, inputs, operationId: crypto.randomUUID(),
    executionContext: { defaultTarget: { executorId: fixture.client.executorId, projectPath: fixture.executionDirs.project } },
  };
}

function startRun(fixture: IntegrationFixture, request: WorkflowStartRequest) {
  return fixture.client.post<WorkflowRunDetail>(workflowPaths.runs, request);
}

function getRun(fixture: IntegrationFixture, runId: string) {
  return fixture.client.get<WorkflowRunDetail>(`${workflowPaths.run}?${new URLSearchParams({ runId })}`);
}

async function waitForRun(
  fixture: IntegrationFixture, runId: string, description: string, ready: (run: WorkflowRunDetail) => boolean,
) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const run = await getRun(fixture, runId);
    if (ready(run)) return run;
    if (performance.now() >= deadline) {
      const steps = run.steps.map(({ step, waitingReason, instances }) => ({
        id: step.id, waitingReason, instances: instances.map(({ key, status, reason }) => ({ key, status, reason })),
      }));
      throw new Error(`Workflow ${runId} did not reach ${description}: ${JSON.stringify({ status: run.status, steps })}`);
    }
    await Bun.sleep(50);
  }
}

test('published Shell workflow binds typed inputs and completes approval across a controller restart', async () => {
  await withIntegrationFixture('workflow-runs-shell-approval', async fixture => {
    const revision = await publish(fixture, shellSource);
    expect(revision).toMatchObject({ definitionId: 'synthetic-acceptance', revision: 1, source: shellSource });
    const request = launchRequest(fixture, revision, { label: 'fixture batch', preview: true });
    expect(await rejectionOf(startRun(fixture, { ...request, inputs: { ...request.inputs, copies: '2' } })))
      .toMatchObject({ status: 400, body: { errorCode: 'VALIDATION_FAILED', error: expect.stringContaining('copies') } });
    expect((await fixture.client.get<WorkflowPage<WorkflowRunSummary>>(workflowPaths.runs)).items).toEqual([]);

    const { id } = await startRun(fixture, request);
    const waiting = await waitForRun(fixture, id, 'ordinary-folder Shell completion and human review', run =>
      stepOf(run, 'review').instances[0]?.status === 'awaiting-decision');
    expect(waiting).toMatchObject({
      kind: 'published', revision: 1, status: 'waiting', pinnedRevision: revision,
      inputs: { label: 'fixture batch', copies: 2, preview: true },
    });
    const command = chatAttempt(onlyInstance(waiting, 'produce'));
    await fixture.client.waitForProcessing(command.chatId, false);
    const { executorId } = fixture.client;
    const projectPath = fixture.executionDirs.project;
    const rows = (await fixture.client.getMessages(command.chatId)).messages.map(row => row.message);
    expect(rows.find(row => row.type === 'command-result')).toMatchObject({
      result: { outcome: 'finished', exitCode: 0, capture: 'complete' },
    });
    expect(rows.find(row => row.type === 'command-output' && row.channel === 'stdout')).toMatchObject({
      content: 'Synthetic complete stdout', context: { executorId, projectPath },
    });
    const executionLog = join(projectPath, 'executions.log');
    expect(await readFile(executionLog, 'utf8')).toBe('produce\n');
    expect(await readdir(projectPath)).not.toContain('.git');

    const [completed] = waiting.signals;
    expect(waiting.signals).toHaveLength(1);
    expect(completed).toMatchObject({
      ref: { stepId: 'produce', signal: 'turn_completed' }, payload: 'Synthetic complete stdout',
      source: { kind: 'completion', attemptId: command.id, chatId: command.chatId, turnId: command.turnId },
    });
    const review = onlyInstance(waiting, 'review');
    expect(review.prompt).toBe('Review fixture batch (2 copies, preview true): Synthetic complete stdout');
    expect(stepOf(waiting, 'finish').instances).toEqual([]);

    const addition = {
      runId: id, operationId: crypto.randomUUID(), source: evidenceReview, evidenceSignalId: completed!.id,
    } satisfies WorkflowAddStepRequest;
    const beforeRestart = await fixture.client.post<WorkflowRunDetail>(workflowPaths.addStep, addition);
    const evidence = onlyInstance(beforeRestart, 'evidence-review');
    expect(evidence).toMatchObject({
      status: 'awaiting-decision', trigger: { kind: 'signal', signalId: completed!.id },
      bindings: { report: 'Synthetic complete stdout' },
    });
    expect(beforeRestart.amendments).toMatchObject([{
      kind: 'add-step', stepId: 'evidence-review', evidenceSignalId: completed!.id,
      operationId: addition.operationId, actor: { name: 'integration' },
    }]);

    await fixture.restartGarcon();
    await fixture.client.post(workflowPaths.addStep, addition);
    const restored = await getRun(fixture, id);
    expect(restored.steps).toEqual(beforeRestart.steps);
    expect(restored.signals).toEqual(waiting.signals);
    expect(restored.amendments).toEqual(beforeRestart.amendments);
    expect(restored.pinnedRevision).toEqual(revision);

    const evidenceDecision = {
      runId: id, operationId: crypto.randomUUID(), instanceId: evidence.id, choice: 'confirm',
    } satisfies WorkflowDecisionRequest;
    expect(await rejectionOf(fixture.client.post(workflowPaths.decide, { ...evidenceDecision, runId: crypto.randomUUID() })))
      .toMatchObject({ status: 404, body: { errorCode: 'WORKFLOW_NOT_FOUND' } });
    await fixture.client.post(workflowPaths.decide, evidenceDecision);
    expect(stepOf(await getRun(fixture, id), 'finish').instances).toEqual([]);

    const worker = executorId !== LOCAL_EXECUTOR_ID ? `/api/v1/executors/${executorId}` : null;
    if (worker) {
      const { executors } = await fixture.client.patch<{ executors: readonly ExecutorSnapshot[] }>(worker, { enabled: false });
      expect(executors.find(executor => executor.id === executorId)).toMatchObject({ enabled: false, availability: 'offline' });
    }
    const approval = { runId: id, operationId: crypto.randomUUID(), instanceId: review.id, choice: 'approve' } satisfies WorkflowDecisionRequest;
    await fixture.client.post(workflowPaths.decide, approval);
    await fixture.client.post(workflowPaths.decide, approval);
    if (worker) {
      const offline = await waitForRun(fixture, id, 'next step waiting for its own executor', run =>
        stepOf(run, 'finish').instances[0]?.status === 'waiting-executor');
      expect(stepOf(offline, 'finish').location).toEqual({ executorId, projectPath });
      expect(onlyInstance(offline, 'finish').attempts.every(attempt => attempt.chatId === null)).toBe(true);
      expect((await fixture.client.listChats()).sessions.map(chat => chat.id)).toEqual([command.chatId]);
      expect(await readFile(executionLog, 'utf8')).toBe('produce\n');
      await fixture.client.patch(worker, { enabled: true });
    }
    const done = await waitForRun(fixture, id, 'approved run completion', run => run.status === 'succeeded');
    expect(stepsOf(done)).toEqual(['produce', 'review', 'finish', 'evidence-review']);
    expect(done.pinnedRevision.definition.steps.map(step => step.id)).toEqual(['produce', 'review', 'finish']);
    expect(await fixture.client.get<WorkflowRevision>(`${workflowPaths.revision}?${new URLSearchParams({ definitionId: request.definitionId })}`))
      .toEqual(revision);
    const decisions = done.signals.filter(signal => signal.source.kind === 'decision');
    expect(decisions.map(signal => ({
      ref: signal.ref, instanceId: signal.instanceId, source: signal.source,
    }))).toMatchObject([
      { ref: { stepId: 'evidence-review', signal: 'confirm' }, instanceId: evidence.id,
        source: { kind: 'decision', actor: { name: 'integration' }, operationId: evidenceDecision.operationId } },
      { ref: { stepId: 'review', signal: 'approve' }, instanceId: review.id,
        source: { kind: 'decision', actor: { name: 'integration' }, operationId: approval.operationId } },
    ]);
    const finish = onlyInstance(done, 'finish');
    expect(finish.trigger).toEqual({ kind: 'signal', signalId: decisions[1]?.id });
    expect(finish.attempts.filter(attempt => attempt.chatId !== null)).toMatchObject([{ status: 'succeeded' }]);
    const chats = (await fixture.client.listChats()).sessions;
    expect(chats).toHaveLength(2);
    for (const chatId of [command.chatId, finish.attempts.find(attempt => attempt.chatId)?.chatId]) {
      const chat = chats.find(chat => chat.id === chatId);
      expect(chat).toMatchObject({ agentId: 'shell', projectPath, parentChatId: null });
      expect(effectiveExecutorId(chat?.executorId)).toBe(executorId);
    }
    expect(await readFile(executionLog, 'utf8')).toBe('produce\nfinish\n');
    if (worker) expect(await Bun.file(join(fixture.dirs.project, 'executions.log')).exists()).toBe(false);
  }, { projectRoots: 'separate' });
}, 90_000);

test('truncated Shell output only unlocks completion-only edges and is not replayed on restart', async () => {
  await withIntegrationFixture('workflow-runs-truncated-output', async fixture => {
    const { id } = await startRun(fixture, launchRequest(fixture, await publish(fixture, truncatedSource), {}));
    const run = await waitForRun(fixture, id, 'truncated output blocking a binding', run =>
      stepOf(run, 'review').instances[0]?.status === 'blocked');
    const command = chatAttempt(onlyInstance(run, 'produce'));
    const rows = (await fixture.client.getMessages(command.chatId)).messages.map(row => row.message);
    expect(rows.find(row => row.type === 'command-result')).toMatchObject({
      result: { outcome: 'finished', exitCode: 0, capture: 'truncated' },
    });
    expect(run.signals).toMatchObject([{
      ref: { stepId: 'produce', signal: 'turn_completed' }, source: { kind: 'completion', turnId: command.turnId },
    }]);
    expect(run.signals[0]).not.toHaveProperty('payload');
    expect(onlyInstance(run, 'review')).toMatchObject({
      status: 'blocked', reason: expect.stringContaining('complete signal payload'), attempts: [],
    });
    expect(onlyInstance(run, 'acknowledge').status).toBe('awaiting-decision');
    await fixture.restartGarcon();
    expect(await getRun(fixture, id)).toMatchObject({ status: 'attention', steps: run.steps, signals: run.signals });
    expect(await readFile(join(fixture.executionDirs.project, 'executions.log'), 'utf8')).toBe('produce\n');
  }, { projectRoots: 'separate' });
}, 60_000);

test('real scripted Codex emits keyed findings before completion and joins every accepted instance exactly once', async () => {
  const environment = await startScriptedCodexTestEnvironment({ model: CODEX_MODELS.DEFAULT, toolMode: 'direct' });
  const { model } = environment;
  const [first, second, third] = findings;
  const duplicate = findingEmit(first);
  const research = holdResearch(model, [
    duplicate, findingEmit(second), findingEmit(third),
  ], duplicate);
  const verdicts = findings.map(({ finding_id }) => `Verified ${finding_id}.`);
  const verifiers = findings.map((finding, index) => model.scriptHeldTurnMatching(finding.finding_id,
    request => request.lastUserText.includes(verifierPrompt(finding)), [codexFinalAnswerMessage(verdicts[index]!)],
  ));
  const summaryPrompt = `Summarize verifications: ${JSON.stringify(verdicts)}`;
  model.scriptTurnMatching('exact joined responses', request => request.lastUserText.includes(summaryPrompt),
    [codexFinalAnswerMessage('All synthetic findings verified.')]);
  try {
    await withIntegrationFixture('workflow-runs-codex-fan-out', async fixture => {
      const { id } = await startRun(fixture, launchRequest(fixture, await publish(fixture, researchSource), { topic }));
      await withTimeout(Promise.all([research.requested, verifiers[0]!.requested, verifiers[1]!.requested]), 20_000,
        () => 'Two verifier requests did not reach the scripted model while Research was held');
      const open = await getRun(fixture, id);
      expect(stepsOf(open)).toEqual(['research', 'verify', 'summary']);
      const producer = onlyInstance(open, 'research');
      const producerAttempt = chatAttempt(producer);
      expect(producer.status).toBe('running');
      expect(open.signals.map(signal => ({
        ref: signal.ref, key: signal.key, payload: signal.payload, instanceId: signal.instanceId, source: signal.source,
      }))).toEqual(findings.map(finding => ({
        ref: { stepId: 'research', signal: 'finding_ready' }, key: finding.finding_id, payload: finding,
        instanceId: producer.id,
        source: { kind: 'attempt', attemptId: producerAttempt.id, chatId: producerAttempt.chatId, turnId: producerAttempt.turnId },
      })));
      const parallel = stepOf(open, 'verify');
      expect(parallel.intake).toBe('open');
      expect(parallel.instances).toMatchObject([
        { key: first.finding_id, status: 'running', bindings: first, trigger: { kind: 'signal', signalId: open.signals[0]!.id } },
        { key: second.finding_id, status: 'running', bindings: second, trigger: { kind: 'signal', signalId: open.signals[1]!.id } },
        { key: third.finding_id, status: 'ready', bindings: third, attempts: [] },
      ]);
      const activeChats = (await fixture.client.get<WorkflowPage<WorkflowActiveChat>>(workflowPaths.activeChats)).items;
      const runningChats = [producer, ...parallel.instances.slice(0, 2)].map(instance => chatAttempt(instance).chatId);
      expect(activeChats.map(chat => chat.chatId).sort()).toEqual(runningChats.sort());
      expect(activeChats.every(chat => chat.runId === id && chat.status === 'running')).toBe(true);
      expect(stepOf(open, 'summary').instances).toEqual([]);

      research.release();
      const closed = await waitForRun(fixture, id, 'Research closing intake', run =>
        onlyInstance(run, 'research').status === 'succeeded');
      expect(closed.signals.filter(signal => signal.ref.signal === 'finding_ready')).toEqual([...open.signals]);
      expect((await fixture.client.getMessages(producerAttempt.chatId)).messages.map(row => row.message))
        .toContainEqual(expect.objectContaining({ type: 'assistant-message', content: duplicate }));
      expect(stepOf(closed, 'verify').intake).toBe('closed');
      expect(stepOf(closed, 'summary').instances).toEqual([]);
      verifiers[1]!.release();
      await withTimeout(verifiers[2]!.requested, 20_000, () => 'Queued verifier did not start after a slot opened');
      verifiers[0]!.release();
      const oneLeft = await waitForRun(fixture, id, 'only the last accepted item still running', run =>
        stepOf(run, 'verify').instances[0]?.status === 'succeeded');
      expect(stepOf(oneLeft, 'verify').instances.map(instance => instance.status)).toEqual(['succeeded', 'succeeded', 'running']);
      expect(stepOf(oneLeft, 'summary').instances).toEqual([]);

      verifiers[2]!.release();
      const done = await waitForRun(fixture, id, 'joined completion', run => run.status === 'succeeded');
      expect(stepsOf(done)).toEqual(stepsOf(open));
      expect(done.pinnedRevision).toEqual(open.pinnedRevision);
      expect(stepOf(done, 'verify').instances.map(instance => instance.id)).toEqual(parallel.instances.map(instance => instance.id));
      expect(stepOf(done, 'verify').instances.map(instance => chatAttempt(instance).status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(onlyInstance(done, 'summary')).toMatchObject({
        status: 'succeeded', prompt: summaryPrompt, bindings: { verifications: verdicts },
        trigger: { kind: 'join', closeSignalId: closed.signals.find(signal => signal.ref.signal === 'turn_completed')?.id },
        attempts: [{ status: 'succeeded' }],
      });
      expect(done.signals.filter(signal => signal.ref.stepId === 'summary')).toMatchObject([{
        ref: { stepId: 'summary', signal: 'turn_completed' }, payload: 'All synthetic findings verified.',
      }]);
      expect((await fixture.client.get<WorkflowPage<WorkflowActiveChat>>(workflowPaths.activeChats)).items).toEqual([]);
      expect(model.requests()).toHaveLength(6);
      model.assertSettled();
    }, { ...environment, projectRoots: 'separate' });
  } finally {
    research.release();
    for (const verifier of verifiers) verifier.release();
    await environment.dispose();
  }
}, 120_000);

test('restarting during a real Codex turn preserves accepted findings but never relaunches unknown work', async () => {
  const environment = await startScriptedCodexTestEnvironment({ model: CODEX_MODELS.DEFAULT, toolMode: 'direct' });
  const { model } = environment;
  const [first, late] = findings;
  const lateEmit = findingEmit(late);
  const research = holdResearch(model, [findingEmit(first)], lateEmit);
  model.scriptTurnMatching(first.finding_id, request => request.lastUserText.includes(verifierPrompt(first)),
    [codexFinalAnswerMessage('First finding verified before restart.')]);
  try {
    await withIntegrationFixture('workflow-runs-codex-unknown', async fixture => {
      const { id } = await startRun(fixture, launchRequest(fixture, await publish(fixture, researchSource), { topic }));
      await withTimeout(research.requested, 20_000, () => 'Research never reached the held response');
      const before = await waitForRun(fixture, id, 'accepted finding verified before restart', run =>
        stepOf(run, 'verify').instances[0]?.status === 'succeeded');
      const producer = onlyInstance(before, 'research');
      const attempt = chatAttempt(producer);
      expect(producer.status).toBe('running');
      expect(before.signals.find(signal => signal.key === first.finding_id)).toMatchObject({
        payload: first, source: { kind: 'attempt', attemptId: attempt.id },
      });
      const remote = fixture.client.executorId !== LOCAL_EXECUTOR_ID;
      if (remote) await fixture.crashAndRestartGarcon({ preserveExecutorWorker: true });
      else await fixture.restartGarcon();
      const recovered = await waitForRun(fixture, id, 'unknown exact attempt recovery', run =>
        onlyInstance(run, 'research').status === 'unknown');
      expect(recovered.status).toBe('attention');
      expect(recovered.signals).toEqual(before.signals);
      expect(stepOf(recovered, 'verify').instances).toEqual(stepOf(before, 'verify').instances);
      expect(onlyInstance(recovered, 'research')).toMatchObject({
        id: producer.id, attempts: [{ id: attempt.id, chatId: attempt.chatId, turnId: attempt.turnId, status: 'unknown' }],
      });
      expect(stepOf(recovered, 'summary').instances).toEqual([]);
      const retry = { runId: id, instanceId: producer.id, operationId: crypto.randomUUID() } satisfies WorkflowRetryRequest;
      expect(await rejectionOf(fixture.client.post(workflowPaths.retry, retry)))
        .toMatchObject({ status: 409, body: { errorCode: 'WORKFLOW_CONFLICT' } });
      research.release();
      if (remote) await reloadUntilNativeContains(fixture, attempt.chatId, lateEmit);
      const after = await getRun(fixture, id);
      expect(after.steps).toEqual(recovered.steps);
      expect(after.signals).toEqual(recovered.signals);
      expect(await fixture.client.deleteChat(attempt.chatId)).toEqual({ success: true });
      const missing = await waitForRun(fixture, id, 'removed attempt chat reflected in the run', run =>
        onlyInstance(run, 'research').attempts[0]?.chatAvailable === false);
      expect(onlyInstance(missing, 'research')).toMatchObject({
        id: producer.id, status: 'unknown', attempts: [{ id: attempt.id, status: 'unknown', chatAvailable: false }],
      });
      expect(missing.signals).toEqual(before.signals);
      expect(stepOf(missing, 'summary').instances).toEqual([]);
      expect(model.requests()).toHaveLength(3);
      model.assertSettled();
    }, { ...environment, projectRoots: 'separate' });
  } finally {
    research.release();
    await environment.dispose();
  }
}, 120_000);
