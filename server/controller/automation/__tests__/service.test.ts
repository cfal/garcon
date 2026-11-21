import { expect, spyOn, test } from 'bun:test';
import { AgentCallError, type AgentIntegration, type ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import type { AutomationSignal } from '../../../../common/automation.js';
import { AssistantMessage } from '../../../../common/chat-types.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { RUNTIME_BACKENDS, type RuntimeBackend } from '../../../remote/__tests__/runtime-adapter.js';
import type { AutomationPreparation } from '../service.js';
import { executorIdFor, managedController, managedInput, managedRuntime, managedWorkspace } from './fixture.js';

const AT = '2026-01-01T00:00:00.000Z';
const emit = (value: string) => `<garcon-workflow-emit signal="finding" content-type="text">${value}</garcon-workflow-emit>`;
const rows = (content: string, originRunId?: string): AgentRuntimeEvent => ({
  type: 'rows', originRunId, rows: [{ message: new AssistantMessage(AT, content) }],
});
const timeout = () => AbortSignal.timeout(5_000);

async function syntheticFixture(backend: RuntimeBackend) {
  const workspace = await managedWorkspace();
  const fixture = integrationFixture(workspace.project, executorIdFor(backend));
  const integration = { ...fixture.integration, liveTurnRows: { scope: 'fresh-start' } } satisfies AgentIntegration;
  const runtime = { ...fixture.executor, async getAgentIntegration() { return integration; } } satisfies ExecutionRuntimeApi;
  const controller = await managedController(workspace, runtime, backend, integration.descriptor.id);
  const input = managedInput(controller.integration, workspace.project, 'synthetic-model', 'Synthetic prompt');
  return { ...controller, fixture, workspace, runtime, input, async cleanup() {
    await controller.dispose();
    await runtime.dispose();
    await workspace.dispose();
  } };
}

function prepared(result: AutomationPreparation) {
  if (result.kind !== 'prepared') throw new Error(`${result.code}: ${result.message}`);
  return result.turn;
}

for (const backend of RUNTIME_BACKENDS) {
  test(`commits exact live rows and drains async signal acceptance before completion (${backend})`, async () => {
    const f = await syntheticFixture(backend);
    const first = Promise.withResolvers<void>();
    const settleFirst = Promise.withResolvers<void>();
    const entered: AutomationSignal[] = [];
    const persisted: string[] = [];
    const capture = Promise.withResolvers<true | undefined>();
    f.fixture.hooks.start = async request => { capture.resolve(request.captureLiveOrigin); };
    try {
      const turn = prepared(await f.automation.prepare(f.input, { async onSignal(signal) {
        entered.push(signal);
        if (entered.length === 1) {
          first.resolve();
          await settleFirst.promise;
          persisted.push('first');
          return { kind: 'accepted' };
        }
        persisted.push('second');
        return { kind: 'rejected', message: 'Synthetic schema rejection' };
      } }));
      const { key } = turn;
      expect(f.chats.getChat(key.chatId)).toBeNull();
      expect(f.fixture.calls.start).toBe(0);
      expect(await Promise.all([turn.start(), turn.start()])).toEqual([{ kind: 'published' }, { kind: 'published' }]);
      await f.queue.waitForDispatches();
      expect(f.fixture.calls.start).toBe(1);
      expect(await capture.promise).toBe(true);
      const publish = f.fixture.nativePublishers[0]!;
      publish(rows(emit('untagged')));
      publish(rows(emit('wrong run'), 'old-turn'));
      publish(rows(`> ${emit('quoted')}`, key.turnId));
      publish(rows(`<garcon-get-chat-id />\n    ${emit('transformed')}`, key.turnId));
      publish(rows(`${emit('first')}\n\n${emit('second')}`, key.turnId));
      publish({ type: 'run-ended', outcome: 'finished', runId: key.turnId, finalResponse: { type: 'text', text: 'Exact final' } });
      publish(rows(emit('late'), key.turnId));
      await first.promise;
      const result = f.automation.waitForTerminal(key, timeout());
      await f.ledger.waitForTurnTerminal(key.chatId, key.turnId, timeout());
      expect(entered.map(event => event.candidate)).toEqual([
        { kind: 'emit', name: 'finding', payload: { contentType: 'text', text: 'first' } },
      ]);
      expect(persisted).toEqual([]);
      settleFirst.resolve();
      expect(await result).toMatchObject({ kind: 'completed', completeText: 'Exact final', receipt: { turnId: key.turnId } });
      expect(persisted).toEqual(['first', 'second']);
      expect(entered.map(event => event.key)).toEqual([key, key]);
      expect(entered[1]?.source).toEqual({ ...entered[0]?.source, index: 1 });
      const address = entered[0]!.source;
      expect(f.transcripts.currentRows(key.chatId).find(row => row.ordinal === address.ordinal)).toMatchObject({
        kind: 'provider-row', message: { content: `${emit('first')}\n\n${emit('second')}` },
      });
      expect(f.transcripts.currentRows(key.chatId)).toContainEqual(expect.objectContaining({ kind: 'notice', message: 'Synthetic schema rejection' }));
      turn.release();
    } finally { settleFirst.resolve(); await f.cleanup(); }
  });

  test(`Shell uses the same port, keeps stdout inert and never calls truncation complete (${backend})`, async () => {
    const workspace = await managedWorkspace();
    const runtime = managedRuntime(workspace, backend, 'shell');
    const f = await managedController(workspace, runtime, backend, 'shell');
    try {
      const input = managedInput(f.integration, workspace.project, 'sh', `printf '%s' '${emit('literal stdout')}'`);
      const rejected = await f.automation.prepare(input, { onSignal: () => { throw new Error('Shell cannot emit'); } });
      expect(rejected).toMatchObject({ kind: 'rejected', code: 'OPERATION_UNSUPPORTED' });
      expect(f.chats.listChatIds()).toEqual([]);
      for (const [command, result] of [
        [input.command, { kind: 'completed', completeText: emit('literal stdout'), commandOutcome: { exitCode: 0, capture: 'complete' } }],
        ["head -c 80000 /dev/zero | tr '\\000' x", { kind: 'completed', completeText: null, commandOutcome: { exitCode: 0, capture: 'truncated' }, receipt: { output: { completeness: 'best-effort' } } }],
        ['exit 7', { kind: 'failed', certainty: 'definite', commandOutcome: { exitCode: 7 } }],
      ] as const) {
        const turn = prepared(await f.automation.prepare({ ...input, command, clientRequestId: crypto.randomUUID() }));
        expect(await turn.start()).toEqual({ kind: 'published' });
        expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject(result);
        expect(f.chats.getChat(turn.key.chatId)?.parentChatId).toBeNull();
        turn.release();
      }
      expect(f.chats.listChatIds()).toHaveLength(3);
    } finally { await f.dispose(); await runtime.dispose(); await workspace.dispose(); }
  });

  test(`unqualified producer failures cannot prove a retryable outcome (${backend})`, async () => {
    const f = await syntheticFixture(backend);
    try {
      const turn = prepared(await f.automation.prepare(f.input));
      expect(await turn.start()).toEqual({ kind: 'published' });
      await f.queue.waitForDispatches();
      f.fixture.nativePublishers[0]!({
        type: 'run-ended', outcome: 'failed', runId: turn.key.turnId,
        error: { code: 'PROVIDER_FAILURE', message: 'The synthetic provider stopped without terminal evidence.' },
      });
      expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject({
        kind: 'failed', certainty: 'unknown', receipt: { state: 'failed', turnId: turn.key.turnId },
      });
    } finally { await f.cleanup(); }
  });
}

test('an exact not-dispatched rejection is not mistaken for post-start loss', async () => {
  const f = await syntheticFixture('local');
  f.fixture.hooks.start = async () => { throw new AgentCallError('not-dispatched', 'Synthetic pre-dispatch rejection'); };
  try {
    const turn = prepared(await f.automation.prepare(f.input));
    expect(await turn.start()).toEqual({ kind: 'published' });
    expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject({
      kind: 'failed', certainty: 'not-started', receipt: { state: 'failed', turnId: turn.key.turnId },
    });
  } finally { await f.cleanup(); }
});

test('cancel and exact Stop cannot launch or stop a substitute turn', async () => {
  const f = await syntheticFixture('local');
  try {
    const canceled = prepared(await f.automation.prepare(f.input));
    expect(await canceled.cancel()).toEqual({ kind: 'not-started' });
    expect(await canceled.start()).toMatchObject({ kind: 'not-started', inputPublished: false });
    expect(await f.automation.waitForTerminal(canceled.key, timeout())).toMatchObject({ kind: 'failed', certainty: 'not-started' });
    expect(f.chats.getChat(canceled.key.chatId)).toBeNull();
    const turn = prepared(await f.automation.prepare(f.input));
    expect(await turn.start()).toEqual({ kind: 'published' });
    await f.queue.waitForDispatches();
    expect(await f.automation.stop({ ...turn.key, clientRequestId: 'wrong' })).toEqual({ kind: 'stale-target' });
    expect(f.fixture.calls.abort).toBe(0);
    expect(await turn.cancel()).toEqual({ kind: 'stop-requested', delivery: 'unknown' });
    expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject({ kind: 'interrupted', termination: 'requested' });
    expect(f.fixture.calls.start).toBe(1);
    expect(f.fixture.calls.abort).toBe(1);
  } finally { await f.cleanup(); }
});

test('a canceled in-flight admission does not create a chat or open its dispatch gate', async () => {
  const f = await syntheticFixture('local');
  const validating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    expect(await f.automation.prepare({ ...f.input, executorId: crypto.randomUUID() }))
      .toMatchObject({ kind: 'rejected', code: 'EXECUTOR_UNAVAILABLE' });
    const turn = prepared(await f.automation.prepare(f.input));
    spyOn(f.agents, 'validateConfiguration').mockImplementation(async () => {
      validating.resolve();
      await release.promise;
    });
    const starting = turn.start();
    await validating.promise;
    const canceling = turn.cancel();
    release.resolve();
    expect(await starting).toMatchObject({ kind: 'not-started', code: 'AUTOMATION_START_CANCELED', inputPublished: false });
    expect(await canceling).toEqual({ kind: 'not-started' });
    await f.queue.waitForDispatches();
    expect(f.chats.listChatIds()).toEqual([]);
    expect(f.fixture.calls.start).toBe(0);
  } finally { release.resolve(); await f.cleanup(); }
});

test('a controller restart cannot recover signal authority from retained or imported rows', async () => {
  const f = await syntheticFixture('local');
  let restarted: Awaited<ReturnType<typeof managedController>> | undefined;
  try {
    const delivered: AutomationSignal[] = [];
    const turn = prepared(await f.automation.prepare(f.input, { onSignal(signal) { delivered.push(signal); } }));
    expect(await turn.start()).toEqual({ kind: 'published' });
    await f.queue.waitForDispatches();
    const publish = f.fixture.nativePublishers[0]!;
    publish(rows(emit('before restart'), turn.key.turnId));
    publish({ type: 'run-ended', runId: turn.key.turnId, outcome: 'finished' });
    expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject({ kind: 'completed', completeText: null });
    expect(delivered).toHaveLength(1);
    await f.dispose();
    restarted = await managedController(f.workspace, f.runtime, 'local', 'test');
    const chatId = turn.key.chatId;
    const view = restarted.transcripts.existingCurrentView(chatId)!;
    const staged = await restarted.transcripts.stageView(chatId, [{ kind: 'provider-row', at: AT, providerMeta: null,
      message: new AssistantMessage(AT, emit('imported')) }], 1);
    restarted.transcripts.replaceCurrentView(chatId, view.viewId, staged.viewId);
    publish(rows(emit('old native callback'), turn.key.turnId));
    expect(await restarted.automation.waitForTerminal(turn.key, timeout())).toMatchObject({ kind: 'unavailable' });
    expect(await restarted.automation.stop(turn.key)).toEqual({ kind: 'requires-explicit-chat-stop', chatId });
    expect(f.fixture.calls.start).toBe(1);
    expect(delivered).toHaveLength(1);
  } finally { await restarted?.dispose(); await f.cleanup(); }
});

test('provider revision drift after prepare cannot retarget managed execution', async () => {
  const f = await syntheticFixture('local');
  try {
    const revision = spyOn(f.agents, 'providerSelectionRevision').mockReturnValue(1);
    const turn = prepared(await f.automation.prepare({ ...f.input, providerRevision: 1 }));
    revision.mockReturnValue(2);
    expect(await turn.start()).toMatchObject({ kind: 'not-started', code: 'API_PROVIDER_CONFIGURATION_CHANGED', inputPublished: false });
    expect(f.chats.getChat(turn.key.chatId)).toBeNull();
    expect(f.fixture.calls.start).toBe(0);
  } finally { await f.cleanup(); }
});

test('losing executor output or signal persistence cannot close required signal intake', async () => {
  for (const failure of ['gap', 'callback'] as const) {
    const f = await syntheticFixture('worker');
    try {
      const turn = prepared(await f.automation.prepare(f.input, { onSignal() {
        if (failure === 'callback') throw new Error('Synthetic write failure');
      } }));
      expect(await turn.start()).toEqual({ kind: 'published' });
      await f.queue.waitForDispatches();
      const publish = f.fixture.nativePublishers[0]!;
      if (failure === 'gap') {
        publish({ ...rows(emit('lost')), originRunId: 42 } as unknown as AgentRuntimeEvent);
      } else publish(rows(emit('unsettled'), turn.key.turnId));
      publish({ type: 'run-ended', runId: turn.key.turnId, outcome: 'finished', finalResponse: { type: 'text', text: 'final' } });
      expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject({ kind: 'unavailable' });
      expect(f.fixture.calls.start).toBe(1);
    } finally { await f.cleanup(); }
  }
});

test('executor loss after dispatch keeps accepted signals and cannot authorize late output or a retry', async () => {
  const f = await syntheticFixture('controller');
  const accepted = Promise.withResolvers<void>();
  const delivered: AutomationSignal[] = [];
  try {
    const turn = prepared(await f.automation.prepare(f.input, { onSignal(signal) { delivered.push(signal); accepted.resolve(); } }));
    expect(await turn.start()).toEqual({ kind: 'published' });
    await f.queue.waitForDispatches();
    const publish = f.fixture.nativePublishers[0]!;
    publish(rows(emit('accepted'), turn.key.turnId));
    await accepted.promise;
    f.agents.executionSessionLost(f.input.executorId);
    publish(rows(emit('late'), turn.key.turnId));
    publish({ type: 'run-ended', runId: turn.key.turnId, outcome: 'finished', finalResponse: { type: 'text', text: 'not observed' } });
    expect(await f.automation.waitForTerminal(turn.key, timeout())).toMatchObject({ kind: 'failed', certainty: 'unknown' });
    expect(await turn.start()).toEqual({ kind: 'published' });
    expect(f.fixture.calls.start).toBe(1);
    expect(delivered).toHaveLength(1);
  } finally { await f.cleanup(); }
});
