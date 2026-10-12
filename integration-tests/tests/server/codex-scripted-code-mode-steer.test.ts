import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../common/json.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import {
  codexAssistantMessage,
  codexCodeModeCall,
  type RecordedCodexModelRequest,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('Code Mode steering yields foreground observation without stopping the cell', async () => {
  const environment = await startScriptedCodexTestEnvironment({ toolMode: 'code_mode_only' });
  const prompt = 'SCRIPTED_CODE_MODE_START';
  const steer = 'SCRIPTED_CODE_MODE_STEER';
  const output = 'SCRIPTED_CODE_MODE_CELL_RESULT';
  const reply = 'SCRIPTED_CODE_MODE_FINISHED';
  let startedPath = '';
  let releasePath = '';
  environment.model.scriptTurn(() => [codexCodeModeCall(
    'call_gated_exec',
    '// @exec: {"yield_time_ms": 60000}\n'
      + `const result = await tools.exec_command({cmd: ${JSON.stringify(
        `touch "${startedPath}"; while [ ! -f "${releasePath}" ]; do sleep 0.05; done; printf ${output}`,
      )}, yield_time_ms: 30000}); text(result.output);`,
  )]);
  const yielded = environment.model.scriptHeldTurn((request) => [{
    type: 'function_call',
    name: 'wait',
    call_id: 'call_cell_wait',
    arguments: JSON.stringify({ cell_id: runningCellId(request), yield_time_ms: 60000 }),
  }]);
  environment.model.scriptTurn((request) => {
    expect(request.functionCallOutputs.find((item) => item.callId === 'call_cell_wait')?.output)
      .toContain(output);
    expect(request.userTexts.filter((text) => text === prompt || text === steer))
      .toEqual([prompt, steer]);
    return [codexAssistantMessage(reply)];
  });

  try {
    await withIntegrationFixture('codex-scripted-code-mode-steer', async (fixture) => {
      startedPath = join(fixture.executionDirs.project, 'code-mode-started');
      releasePath = join(fixture.executionDirs.project, 'code-mode-release');
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.dirs.project, command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      try {
        const deadline = Date.now() + 10_000;
        while (!await Bun.file(startedPath).exists() && Date.now() < deadline) await Bun.sleep(20);
        expect(await Bun.file(startedPath).exists()).toBe(true);
        const accepted = await fixture.client.steer({
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          chatId, content: steer,
        });
        expect(accepted).toMatchObject({ status: 'accepted', turnId: active.turnId });
        const observation = await withTimeout(yielded.requested, 10_000,
          () => 'Steering did not yield before the nested command gate opened.');
        expect(runningCellId(observation)).not.toBe('');
        expect(observation.lastUserText).toBe(steer);
        expect(await Bun.file(releasePath).exists()).toBe(false);
        expect(environment.model.requests()).toHaveLength(2);

        await writeFile(releasePath, 'release');
        yielded.release();
        await waitForVisibleResponse({ fixture, chatId, turnId: active.turnId, marker: reply, afterIndex: cursor });
        const transcript = (await fixture.client.getMessages(chatId)).messages;
        expect(userContents(transcript)).toEqual([prompt, steer]);
        expect(assistantContents(transcript).filter((text) => text === reply)).toEqual([reply]);
        const commands = messagesOfType(transcript, 'bash-tool-use')
          .filter((message) => message.command.includes(output));
        expect(commands).toHaveLength(1);
        expect(messagesOfType(transcript, 'tool-result')
          .filter((message) => message.toolId === commands[0]?.toolId)).toHaveLength(1);
        expect(environment.model.requests()).toHaveLength(3);
        environment.model.assertSettled();
      } finally {
        await writeFile(releasePath, 'release').catch(() => undefined);
        yielded.release();
      }
    }, environment);
  } finally {
    yielded.release();
    await environment.dispose();
  }
}, 120_000);

function runningCellId(request: RecordedCodexModelRequest): string {
  const items = Array.isArray(request.body.input) ? request.body.input : [];
  const result = items.find((item) => isRecord(item)
    && item.type === 'custom_tool_call_output' && item.call_id === 'call_gated_exec');
  if (!isRecord(result) || typeof result.output !== 'string') {
    throw new Error('Code Mode did not return the exec observation.');
  }
  const cellId = /^Script running with cell ID ([^\n]+)/.exec(result.output)?.[1];
  if (!cellId) throw new Error(`Code Mode did not yield a running cell: ${result.output}`);
  return cellId;
}
