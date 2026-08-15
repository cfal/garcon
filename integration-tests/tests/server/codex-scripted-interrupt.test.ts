import type { ServerWsMessage } from '../../../common/ws-events.js';
import { access, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assistantContents, messagesOfType } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexCodeModeCall,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectStoppedTurnEventOrder,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveCodexRunRequest,
  liveCodexStartRequest,
} from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex interrupt lifecycle', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment({ toolMode: 'code_mode' });
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('stops an active command and preserves later delivery', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const stoppedReply = marker('SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('RECOVERY_REPLY');
    const stoppedPrompt = marker('STOPPED_PROMPT');
    const recoveryPrompt = marker('RECOVERY_PROMPT');
    const startedFile = '.codex-scripted-stop-started';
    const nativeOnlyTool = marker('NATIVE_ONLY_TOOL');
    const command = `touch ${startedFile} && sleep 30`;
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_stopped', command)]);

    await withIntegrationFixture('codex-scripted-interrupt', async (fixture) => {
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: stoppedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!active.turnId) throw new Error('Codex start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, startedFile));
      const nativePath = await waitForNativeSessionPath(fixture.dirs.workspace, chatId);
      await appendNativeOnlyTool(nativePath, nativeOnlyTool);

      const stopCursor = fixture.client.markEvents();
      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.outcome).toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await fixture.client.waitForEvent(
        (event): event is ServerWsMessage => event.type === 'chat-session-stopped'
          && event.chatId === chatId,
        `${chatId} chat-session-stopped`,
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .not.toContain(stoppedReply);

      const recoveryCommandMarker = marker('RECOVERY_COMMAND');
      const recoveryCommand = `printf ${JSON.stringify(recoveryCommandMarker)}`;
      testEnvironment.model.scriptTurn([codexCodeModeCall(
        'call_recovery_code_mode',
        `const result = await tools.exec_command({cmd: ${JSON.stringify(recoveryCommand)}}); text(result.output);`,
      )]);
      testEnvironment.model.scriptTurn([codexAssistantMessage(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(liveCodexRunRequest({
        chatId,
        command: recoveryPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      const liveMessages = fixture.client.eventsSince(recoveryCursor).flatMap((event) =>
        event.type === 'chat-messages'
          && event.chatId === chatId
          ? event.messages
          : []);
      expect(assistantContents(liveMessages).filter((content) => content === recoveryReply))
        .toEqual([recoveryReply]);
      const liveRecoveryCommands = messagesOfType(liveMessages, 'bash-tool-use')
        .filter((message) => message.command.includes(recoveryCommandMarker));
      expect(liveRecoveryCommands).toHaveLength(1);
      expect(
        messagesOfType(liveMessages, 'tool-result')
          .filter((message) => message.toolId === liveRecoveryCommands[0]?.toolId),
      ).toHaveLength(1);

      const messages = (await fixture.client.getMessages(chatId)).messages;
      expect(JSON.stringify(fixture.client.eventsSince(stopCursor))).not.toContain(nativeOnlyTool);
      expect(JSON.stringify(messages)).not.toContain(nativeOnlyTool);
      expect(assistantContents(messages).filter((content) => content === recoveryReply))
        .toEqual([recoveryReply]);
      const recoveryCommands = messagesOfType(messages, 'bash-tool-use')
        .filter((message) => message.command.includes(recoveryCommandMarker));
      expect(recoveryCommands).toHaveLength(1);
      expect(
        messagesOfType(messages, 'tool-result')
          .filter((message) => message.toolId === recoveryCommands[0]?.toolId),
      ).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });
});

function marker(label: string): string {
  return `SCRIPTED_CODEX_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Codex never created ${path}.`);
}

async function waitForNativeSessionPath(
  workspace: string,
  chatId: string,
): Promise<string> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const registry = JSON.parse(await readFile(join(workspace, 'chats.json'), 'utf8')) as {
        sessions?: Record<string, { nativeSession?: { value?: { path?: unknown } } }>;
      };
      const nativePath = registry.sessions?.[chatId]?.nativeSession?.value?.path;
      if (typeof nativePath === 'string' && nativePath) return nativePath;
    } catch {
      // Session metadata is persisted asynchronously after activation.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Codex never persisted a native path for ${chatId}.`);
}

async function appendNativeOnlyTool(nativePath: string, markerText: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const callId = `native-only-${crypto.randomUUID()}`;
  await appendFile(nativePath, [
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        call_id: callId,
        arguments: JSON.stringify({ command: ['printf', markerText] }),
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: callId, output: markerText },
    }),
    '',
  ].join('\n'));
}
