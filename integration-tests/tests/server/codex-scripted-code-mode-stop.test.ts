import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../common/json.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { codexAssistantMessage, codexCodeModeCall } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectStoppedTurnEventOrder, waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('Stop terminates a running Code Mode cell and permits a new turn', async () => {
  // Code Mode interruption is enabled by default in the pinned release.
  // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/features/src/lib.rs#L1195-L1200
  const environment = await startScriptedCodexTestEnvironment({ toolMode: 'code_mode_only' });
  const recoveryReply = 'SCRIPTED_CODE_MODE_STOP_RECOVERED';
  let startedPath = '';
  let releasePath = '';
  let finishedPath = '';
  let cellId = '';
  environment.model.scriptTurn([codexCodeModeCall('call_store_probe', 'store("garcon_stop_probe", "kept");')]);
  environment.model.scriptTurn(() => [codexCodeModeCall(
    'call_stopped_cell',
    '// @exec: {"yield_time_ms": 1000}\n'
      + 'store("garcon_stop_probe", "leaked");\n'
      + `await tools.exec_command({cmd: ${JSON.stringify(
        `touch "${startedPath}"; while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      )}, yield_time_ms: 30000});\n`
      + `await tools.exec_command({cmd: ${JSON.stringify(`touch "${finishedPath}"`)}});`,
  )]);
  const held = environment.model.scriptHeldTurn([codexAssistantMessage('SCRIPTED_CODE_MODE_NOT_STOPPED')]);
  environment.model.scriptTurn(() => [{
    type: 'function_call', name: 'wait', call_id: 'call_verify_stopped_cell',
    arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 1000 }),
  }]);
  environment.model.scriptTurn((request) => {
    // Interrupt retires active cells; a later wait must report the old cell missing.
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tasks/mod.rs#L946-L957
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/code-mode-runtime/src/service.rs#L414-L424
    expect(request.functionCallOutputs.find((item) => item.callId === 'call_verify_stopped_cell')?.output)
      .toContain(`exec cell ${cellId} not found`);
    return [codexCodeModeCall('call_recovered_cell', 'text(String(load("garcon_stop_probe")));')];
  });
  environment.model.scriptTurn((request) => {
    const input = Array.isArray(request.body.input) ? request.body.input : [];
    const result = input.find((item) => isRecord(item)
      && item.type === 'custom_tool_call_output' && item.call_id === 'call_recovered_cell');
    // The completed cell's store survives only when recovery reuses the interrupted session.
    // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/code-mode-runtime/src/session_runtime/mod.rs#L286-L303
    expect(isRecord(result) && JSON.stringify(result.output)).toContain('kept');
    return [codexAssistantMessage(recoveryReply)];
  });

  try {
    await withIntegrationFixture('codex-scripted-code-mode-stop', async (fixture) => {
      startedPath = join(fixture.executionDirs.project, 'code-mode-started');
      releasePath = join(fixture.executionDirs.project, 'code-mode-release');
      finishedPath = join(fixture.executionDirs.project, 'code-mode-finished');
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'SCRIPTED_CODE_MODE_STOP',
        permissionMode: 'bypassPermissions',
      }));
      if (!active.turnId) throw new Error('Codex start response omitted its turn id.');
      try {
        const observation = await withTimeout(held.requested, 10_000,
          () => 'Code Mode did not yield its running cell.');
        const input = Array.isArray(observation.body.input) ? observation.body.input : [];
        const result = input.find((item) => isRecord(item)
          && item.type === 'custom_tool_call_output' && item.call_id === 'call_stopped_cell');
        if (!isRecord(result) || typeof result.output !== 'string') {
          throw new Error('Code Mode did not return the exec observation.');
        }
        cellId = /^Script running with cell ID (\d+)\n/.exec(result.output)?.[1] ?? '';
        expect(cellId).not.toBe('');
        const deadline = Date.now() + 10_000;
        while (!await Bun.file(startedPath).exists() && Date.now() < deadline) await Bun.sleep(20);
        expect(await Bun.file(startedPath).exists()).toBe(true);
        const stopCursor = fixture.client.markEvents();
        expect(await fixture.client.stopChat({ clientRequestId: crypto.randomUUID(), chatId }))
          .toMatchObject({ outcome: 'interrupt-requested' });
        await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor });

        const recoveryCursor = fixture.client.markEvents();
        const recovered = await fixture.client.runChat(liveCodexRunRequest({
          chatId, command: 'SCRIPTED_CODE_MODE_STOP_RECOVER', permissionMode: 'bypassPermissions',
        }));
        await waitForVisibleResponse({
          fixture, chatId, turnId: recovered.turnId, marker: recoveryReply, afterIndex: recoveryCursor,
        });
        const events = fixture.client.eventsSince(stopCursor);
        expectStoppedTurnEventOrder(events, chatId, active.turnId);
        const messages = (await fixture.client.getMessages(chatId)).messages;
        expect(events.filter((event) => (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
          && event.chatId === chatId)).toMatchObject([
          { type: 'agent-run-finished', turnId: active.turnId, outcome: 'interrupted' },
          { type: 'agent-run-finished', turnId: recovered.turnId, outcome: 'finished' },
        ]);
        expect(assistantContents(messages)).not.toContain('SCRIPTED_CODE_MODE_NOT_STOPPED');
        expect(assistantContents(messages).filter((text) => text === recoveryReply)).toEqual([recoveryReply]);
        expect(await Bun.file(finishedPath).exists()).toBe(false);
        environment.model.assertSettled();
      } finally {
        held.release();
        await writeFile(releasePath, 'release').catch(() => undefined);
      }
    }, environment);
  } finally {
    held.release();
    await environment.dispose();
  }
}, 120_000);
