import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { workflowPaths } from '../../../common/workflow-http.js';
import type { WorkflowRevision, WorkflowRunDetail } from '../../../common/workflow-runs.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { claudeText, claudeToolUse, type HeldClaudeTurn } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

const DEFINITION_ID = 'claude-live-signal';
const FINAL = 'Synthetic research complete.';
const VERIFIED = 'Synthetic dependent command ran.';
const SOURCE = `
version: 1
name: Claude finding handoff
steps:
  - id: research
    kind: agent
    agentId: claude
    model: haiku
    permissionMode: bypassPermissions
    thinkingMode: low
    prompt: Collect a synthetic finding.
    signals:
      finding_ready:
        payload: json
        delivery: many
        key: finding_id
        fields: { finding_id: string, claim: string }
  - id: verify
    kind: command
    on: { kind: each, signal: research.finding_ready, maxConcurrency: 1 }
    command: |
      printf '%s' '${VERIFIED}'
`;

function emit(finding_id: string, claim: string): string {
  return `<garcon-workflow-emit signal="research.finding_ready" content-type="json">${JSON.stringify({ finding_id, claim })}</garcon-workflow-emit>`;
}

const payload = { finding_id: 'observed', claim: 'Two and two make four.' };
const proof = emit(payload.finding_id, payload.claim);
const prose = `This is an example, not a finding:\n\n${emit('surrounded', 'Surrounding prose.')}`;
const quote = `> ${emit('quoted', 'Quoted sample.')}`;
const ordinary = emit('ordinary', 'Not from a workflow.');

function step(run: WorkflowRunDetail, id: string) {
  const entry = run.steps.find(candidate => candidate.step.id === id);
  if (!entry) throw new Error(`Workflow is missing step ${id}.`);
  return entry;
}

function findings(run: WorkflowRunDetail) {
  return run.signals.filter(signal => signal.ref.stepId === 'research' && signal.ref.signal === 'finding_ready');
}

async function waitForRun(
  read: () => Promise<WorkflowRunDetail>, description: string, ready: (run: WorkflowRunDetail) => boolean,
): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  let run = await read();
  while (!ready(run) && run.status !== 'attention' && Date.now() < deadline) {
    await Bun.sleep(25);
    run = await read();
  }
  if (!ready(run)) {
    throw new Error(`${description} did not settle: ${JSON.stringify({
      status: run.status, signals: run.signals, attempts: run.steps.flatMap(entry => entry.instances.map(instance => ({
        step: entry.step.id, status: instance.status, reason: instance.reason, attempts: instance.attempts,
      }))),
    })}`);
  }
  return run;
}

test('published workflow accepts one live pinned Claude finding and starts the waiting step before completion', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  const { model } = environment;
  const gates: HeldClaudeTurn[] = [];
  const hold = (text: string, probe?: string) => {
    const gate = model.scriptHeldTurn([
      claudeText(text),
      ...(probe ? [claudeToolUse(`toolu_workflow_${probe}`, 'Bash', { command: 'printf synthetic' })] : []),
    ]);
    gates.push(gate);
    return gate;
  };
  const requested = (gate: HeldClaudeTurn, label: string) => withTimeout(
    gate.requested, LIVE_TURN_TIMEOUT_MS, () => `Pinned Claude did not request ${label}.`,
  );
  try {
    await withIntegrationFixture('workflow-claude-live-signals', async fixture => {
      const { client } = fixture;
      const projectPath = fixture.executionDirs.project;
      const revision = await client.post<WorkflowRevision>(workflowPaths.definitions, {
        definitionId: DEFINITION_ID, expectedRevision: null, source: SOURCE,
      });
      expect(revision).toMatchObject({ definitionId: DEFINITION_ID, revision: 1 });
      const opening = hold(prose, 'prose');
      const run = await client.post<WorkflowRunDetail>(workflowPaths.runs, {
        definitionId: DEFINITION_ID, revision: 1, inputs: {},
        executionContext: { defaultTarget: { executorId: client.executorId, projectPath } },
      });
      expect(run).toMatchObject({ kind: 'published', definitionId: DEFINITION_ID, revision: 1 });
      const read = () => client.get<WorkflowRunDetail>(`${workflowPaths.run}?runId=${encodeURIComponent(run.id)}`);
      const assertWaiting = async () => {
        const detail = await read();
        expect(step(detail, 'research').instances[0]?.status).toBe('running');
        expect(findings(detail)).toEqual([]);
        expect(step(detail, 'verify').instances).toEqual([]);
      };
      try {
        await requested(opening, 'the research prompt');
        const active = await read();
        const research = step(active, 'research').instances[0]?.attempts[0];
        if (!research?.chatId || !research.turnId) throw new Error('Research started without its exact chat and turn identity.');
        await assertWaiting();

        model.scriptTurn([claudeText(ordinary)]);
        const ordinaryChatId = fixture.newChatId();
        const ordinaryEvents = client.markEvents();
        const chat = await client.startChat({
          ...liveClaudeStartRequest({ chatId: ordinaryChatId, projectPath, command: 'Print a synthetic sample.' }),
          model: 'haiku',
        });
        expectFinished((await client.waitForTurnTerminal(ordinaryChatId, chat.turnId, {
          afterIndex: ordinaryEvents, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        expect(assistantContents((await client.getMessages(ordinaryChatId)).messages)).toContain(ordinary);
        await assertWaiting();

        const quoted = hold(quote, 'quote');
        opening.release();
        await requested(quoted, 'the turn after the surrounding prose');
        expect(assistantContents((await client.getMessages(research.chatId)).messages)).toContain(prose);
        await assertWaiting();

        const signal = hold(proof, 'emit');
        quoted.release();
        await requested(signal, 'the turn after the quoted tag');
        expect(assistantContents((await client.getMessages(research.chatId)).messages)).toContain(quote);
        await assertWaiting();

        const final = hold(FINAL);
        signal.release();
        await requested(final, 'the final response');
        const live = await waitForRun(read, 'The dependent command', detail => (
          step(detail, 'verify').instances.some(instance => instance.status === 'succeeded')
        ));
        expect(step(live, 'research').instances[0]?.status).toBe('running');
        expect(findings(live)).toEqual([expect.objectContaining({
          payload, key: payload.finding_id,
          source: { kind: 'attempt', attemptId: research.id, chatId: research.chatId, turnId: research.turnId },
        })]);
        expect(step(live, 'verify').instances).toEqual([expect.objectContaining({
          key: payload.finding_id, trigger: { kind: 'signal', signalId: findings(live)[0]!.id }, status: 'succeeded',
        })]);
        const dependent = step(live, 'verify').instances[0]?.attempts[0];
        if (!dependent?.chatId || !dependent.turnId) throw new Error('Dependent step did not start an exact chat turn.');
        expect(parseAgentTurnReceipt(await client.get(
          `/api/v1/chats/turn-receipt?chatId=${dependent.chatId}&turnId=${dependent.turnId}`,
        ))).toMatchObject({ state: 'completed', output: { availability: 'available', completeness: 'complete', text: VERIFIED } });

        final.release();
        const completed = await waitForRun(read, 'The published run', detail => detail.status === 'succeeded');
        expect(findings(completed)).toEqual(findings(live));
        expect(step(completed, 'verify').instances).toHaveLength(1);
        model.assertSettled();
      } finally {
        for (const gate of gates) gate.release();
      }
    }, { serverEnvironment: environment.serverEnvironment, projectRoots: 'separate' });
  } finally {
    environment.dispose();
  }
}, 120_000);

test('a successful Claude result without response text does not authorize workflow retry', async () => {
  await withIntegrationFixture('workflow-claude-empty-result', async ({ client, executionDirs }) => {
    const run = await client.post<WorkflowRunDetail>(workflowPaths.testDraft, {
      source: SOURCE, inputs: {}, operationId: crypto.randomUUID(),
      executionContext: { defaultTarget: { executorId: client.executorId, projectPath: executionDirs.project } },
    });
    const detail = await waitForRun(
      () => client.get<WorkflowRunDetail>(`${workflowPaths.run}?runId=${run.id}`), 'Empty result',
      candidate => Boolean(step(candidate, 'research').instances[0]?.attempts[0]?.finishedAt),
    );
    const instance = step(detail, 'research').instances[0]!;
    expect(instance).toMatchObject({ status: 'unknown', reason: expect.stringContaining('without producing a response') });
    expect(detail.signals).toEqual([]);
    expect(await rejectionOf(client.post(workflowPaths.retry, {
      runId: run.id, instanceId: instance.id, operationId: crypto.randomUUID(),
    }))).toMatchObject({ status: 409, body: { errorCode: 'WORKFLOW_CONFLICT' } });
  }, {
    resolveServerEnvironment: dirs => ({
      CLAUDE_BINARY: join(dirs.root, 'synthetic-claude'), CLAUDE_CONFIG_DIR: join(dirs.home, '.claude-integration'),
      ANTHROPIC_API_KEY: 'integration-fake-claude-key', CLAUDE_TEST_EMPTY_SUCCESS: '1',
    }),
    async prepareWorkspace(dirs) {
      const cli = new URL('../../support/fake-claude-cli.ts', import.meta.url);
      await writeFile(join(dirs.root, 'synthetic-claude'), `#!${process.execPath}\nimport ${JSON.stringify(cli.href)};\n`, { mode: 0o755 });
    },
  });
}, 60_000);
