import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { CODEX_MODELS } from '../../../common/models.js';
import { workflowPaths } from '../../../common/workflow-http.js';
import type { WorkflowRevision, WorkflowRunDetail } from '../../../common/workflow-runs.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

const PROMPT = 'Review a synthetic finding.';
const SOURCE = `version: 1
name: Exact failure evidence
steps:
  - id: research
    kind: agent
    agentId: codex
    model: ${CODEX_MODELS.DEFAULT}
    thinkingMode: low
    prompt: ${PROMPT}
  - id: confirm
    kind: decision
    on: { kind: once, signal: research.turn_completed }
    prompt: Confirm the research.
    choices: { accept: Accept }
`;

async function launch(fixture: IntegrationFixture) {
  const { client } = fixture;
  const revision = await client.post<WorkflowRevision>(workflowPaths.definitions, {
    definitionId: 'exact-failure', expectedRevision: null, source: SOURCE,
  });
  const { id } = await client.post<WorkflowRunDetail>(workflowPaths.runs, {
    definitionId: revision.definitionId, revision: revision.revision, inputs: {},
    executionContext: { defaultTarget: { executorId: client.executorId, projectPath: fixture.executionDirs.project } },
  });
  const read = () => client.get<WorkflowRunDetail>(`${workflowPaths.run}?runId=${encodeURIComponent(id)}`);
  const wait = async (description: string, ready: (detail: WorkflowRunDetail) => boolean) => {
    const deadline = Date.now() + 20_000;
    let detail = await read();
    while (!ready(detail) && Date.now() < deadline) {
      await Bun.sleep(25);
      detail = await read();
    }
    if (!ready(detail)) throw new Error(`${description}: ${JSON.stringify(detail.steps)}`);
    return detail;
  };
  const retry = (instanceId: string) => client.post<WorkflowRunDetail>(workflowPaths.retry, {
    runId: id, instanceId, operationId: crypto.randomUUID(),
  });
  return { wait, read, retry };
}

function research(detail: WorkflowRunDetail) {
  return detail.steps.find(entry => entry.step.id === 'research')?.instances[0];
}

test('Codex app-server loss after native turn admission does not offer workflow retry', async () => {
  let releasePath = '';
  await withIntegrationFixture('workflow-codex-process-loss', async fixture => {
    const run = await launch(fixture);
    const started = await run.wait('the native attempt was not published', detail => Boolean(research(detail)?.attempts[0]?.chatId));
    const instance = research(started)!;
    const { chatId, turnId } = instance.attempts[0]!;
    if (!chatId || !turnId) throw new Error('Missing exact attempt identity');
    try {
      await fixture.client.waitForEvent((event): event is ChatMessagesMessage => (
        event.type === 'chat-messages' && event.chatId === chatId
        && assistantContents(event.messages).includes(`codex-live2-${PROMPT}`)
      ), 'output from the admitted native Codex turn');
      expect(research(await run.read())?.status).toBe('running');
    } finally {
      await writeFile(releasePath, 'exit');
    }

    const settled = await run.wait('the lost attempt did not settle', detail => detail.status === 'attention');
    expect(research(settled)).toMatchObject({ status: 'unknown', attempts: [{ chatId, turnId, status: 'unknown' }] });
    expect(settled.signals).toEqual([]);
    expect(settled.steps.find(entry => entry.step.id === 'confirm')?.instances).toEqual([]);
    expect(parseAgentTurnReceipt(await fixture.client.get(`/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${turnId}`)))
      .toMatchObject({ state: 'failed', errorCode: 'OUTCOME_UNKNOWN', error: expect.stringContaining('exited with code 137') });
    expect(await rejectionOf(run.retry(instance.id))).toMatchObject({ status: 409, body: { errorCode: 'WORKFLOW_CONFLICT' } });
    expect(research(await run.read())?.attempts).toHaveLength(1);
  }, {
    resolveServerEnvironment(dirs) {
      releasePath = join(dirs.root, 'codex-exit-release');
      return {
        GARCON_CODEX_CLI: fileURLToPath(new URL('../../support/fake-codex-app-server.ts', import.meta.url)),
        PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        INTEGRATION_CODEX_STREAMING_TURN: '1',
        INTEGRATION_CODEX_TURN_RELEASE: releasePath,
        INTEGRATION_CODEX_EXIT_WITHOUT_TERMINAL: '1',
      };
    },
  });
}, 60_000);

test('an explicit native Codex turn failure still permits a fresh managed retry', async () => {
  const environment = await startScriptedCodexTestEnvironment({ model: CODEX_MODELS.DEFAULT, toolMode: 'direct' });
  const message = 'Synthetic provider refusal.';
  environment.model.scriptFault({ kind: 'stream-error', code: 'inference_hook_denied', message });
  environment.model.scriptTurn([codexFinalAnswerMessage('Synthetic retry completed.')]);
  try {
    await withIntegrationFixture('workflow-codex-native-failure', async fixture => {
      const run = await launch(fixture);
      const detail = await run.wait('the native terminal was not recorded', candidate => candidate.status === 'attention');
      const failed = research(detail)!;
      expect(failed).toMatchObject({ status: 'failed', reason: message, attempts: [{ status: 'failed' }] });
      expect(detail.signals).toEqual([]);
      expect(environment.model.requests()).toHaveLength(1);
      expect(research(await run.retry(failed.id))?.id).toBe(failed.id);
      const recovered = await run.wait('the retry did not complete', candidate => research(candidate)?.status === 'succeeded');
      const attempts = research(recovered)!.attempts;
      expect(attempts.map(attempt => attempt.status)).toEqual(['failed', 'succeeded']);
      expect(attempts[1]?.chatId).not.toBe(attempts[0]?.chatId);
      expect(recovered.signals.map(signal => signal.ref)).toEqual([{ stepId: 'research', signal: 'turn_completed' }]);
      expect(environment.model.requests()).toHaveLength(2);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 120_000);
