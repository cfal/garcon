import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  geminiFunctionCall,
  geminiText,
  geminiThought,
} from '../../support/fake-gemini-model.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import {
  ANTIGRAVITY_BINARY,
  ANTIGRAVITY_TEST_ALTERNATE_MODEL,
  ANTIGRAVITY_TEST_MODEL,
  antigravityAgentSessionId,
  scriptedAntigravityRunRequest,
  scriptedAntigravityStartRequest,
  startScriptedAntigravityTestEnvironment,
  type ScriptedAntigravityTestEnvironment,
} from '../../support/scripted-antigravity.js';

const TURN_TIMEOUT_MS = 120_000;

let environment: ScriptedAntigravityTestEnvironment | undefined;

function requireEnvironment(): ScriptedAntigravityTestEnvironment {
  if (!environment) throw new Error('Scripted Antigravity environment was not started.');
  return environment;
}

function withScriptedAntigravity() {
  const current = requireEnvironment();
  return { serverEnvironment: current.serverEnvironment, prepareWorkspace: current.prepareWorkspace };
}

function marker(name: string): string {
  return `${name}_${crypto.randomUUID().slice(0, 8)}`;
}

describe.skipIf(!ANTIGRAVITY_BINARY)('scripted Antigravity', () => {
  beforeEach(() => {
    environment = startScriptedAntigravityTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('lists the account models from agy and reports API-key authentication', async () => {
    await withIntegrationFixture('antigravity-scripted-catalog', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      const antigravity = catalog.agents.find((agent) => agent.id === 'antigravity');
      if (!antigravity) throw new Error('Antigravity was not listed in the catalog.');
      expect(antigravity.models.map((model) => model.value)).toEqual(
        expect.arrayContaining([ANTIGRAVITY_TEST_MODEL, ANTIGRAVITY_TEST_ALTERNATE_MODEL]),
      );
      expect(antigravity.models.find((model) => model.value === ANTIGRAVITY_TEST_MODEL)?.label)
        .toBe('Gemini 3.1 Pro (Low)');
      expect(antigravity.authLoginSupported).toBe(true);
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('runs an approved command and resumes the same session with another model', async () => {
    const testEnvironment = requireEnvironment();
    const output = marker('COMMAND_OUTPUT');
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    const command = `printf %s ${output} > command-output.txt && cat command-output.txt`;
    testEnvironment.model.scriptTurn([
      geminiThought('Planning the command.'),
      geminiFunctionCall('scripted-command', 'run_command', {
        CommandLine: command,
        toolSummary: 'Write and print the marker',
        WaitMsBeforeAsync: 5000,
      }),
    ]);
    testEnvironment.model.scriptTurn((request) => {
      const response = request.functionResponses.find((entry) => entry.id === 'scripted-command');
      expect(JSON.stringify(response?.response)).toContain(output);
      return [geminiText(firstReply)];
    });
    testEnvironment.model.scriptTurn((request) => {
      expect(request.userTexts.some((text) => text.includes(secondPrompt))).toBe(true);
      expect(request.functionResponses.map((entry) => entry.id)).toContain('scripted-command');
      return [geminiText(secondReply)];
    });

    await withIntegrationFixture('antigravity-scripted-command', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'run the scripted command',
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request'
          && row.message.requestedTool.type === 'bash-tool-use'
          && row.message.requestedTool.command === command,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') throw new Error('Expected a command permission request.');
      expect((await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
      })).status).toBe('accepted');
      await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, marker: firstReply, afterIndex: cursor });

      expect(await readFile(join(fixture.executionDirs.project, 'command-output.txt'), 'utf8')).toBe(output);
      const firstMessages = (await fixture.client.getMessages(chatId)).messages;
      expect(messagesOfType(firstMessages, 'thinking').map((message) => message.content)).toEqual(['Planning the command.']);
      expect(messagesOfType(firstMessages, 'bash-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-command', command, description: 'Write and print the marker' }),
      ]);
      const result = messagesOfType(firstMessages, 'tool-result').find((message) => message.toolId === 'scripted-command');
      expect(result?.isError).toBe(false);
      expect(String(result?.content.raw)).toContain(output);
      expect(String(result?.content.raw)).not.toContain('Created At:');
      const sessionId = await antigravityAgentSessionId(fixture, chatId);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedAntigravityRunRequest({
        chatId, command: secondPrompt, model: ANTIGRAVITY_TEST_ALTERNATE_MODEL,
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: second.turnId, marker: secondReply, afterIndex: secondCursor });

      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      const transcript = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(transcript)).toEqual(['run the scripted command', secondPrompt]);
      expect(assistantContents(transcript)).toEqual([firstReply, secondReply]);
      // agy reports the switch to the model as a settings change on the next request.
      expect(testEnvironment.model.requests().at(-1)?.lastUserText).toContain('Gemini 3.1 Pro (High)');
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('denies a command with the agent-defined deny option', async () => {
    const testEnvironment = requireEnvironment();
    const command = 'printf %s denied > denied-command.txt && cat denied-command.txt';
    testEnvironment.model.scriptTurn([
      geminiFunctionCall('denied-command', 'run_command', {
        CommandLine: command, toolSummary: 'Write the denied marker', WaitMsBeforeAsync: 5000,
      }),
    ]);

    await withIntegrationFixture('antigravity-scripted-deny', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'try the denied command',
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request' && row.message.requestedTool.type === 'bash-tool-use',
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') throw new Error('Expected a command permission request.');
      await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: false,
        alwaysAllow: false,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');

      expect(await Bun.file(join(fixture.executionDirs.project, 'denied-command.txt')).exists()).toBe(false);
      const messages = (await fixture.client.getMessages(chatId)).messages;
      expect(messagesOfType(messages, 'tool-result')).toEqual([
        expect.objectContaining({ toolId: 'denied-command', isError: true }),
      ]);
      expect(messagesOfType(messages, 'permission-resolved')).toEqual([
        expect.objectContaining({ allowed: false }),
      ]);
      expect(testEnvironment.model.requests()).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('writes and edits files without prompting in accept-edits mode', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('EDITS_DONE');
    testEnvironment.model.scriptTurn((request) => [
      geminiFunctionCall('scripted-read', 'read_file', { Path: join(projectPathFrom(request.lastUserText), 'notes.txt') }),
    ]);
    testEnvironment.model.scriptTurn((request) => [
      geminiFunctionCall('scripted-write', 'write_file', {
        Path: join(projectPathFrom(request.userTexts[0] ?? ''), 'created.txt'), Content: 'created\n',
      }),
    ]);
    testEnvironment.model.scriptTurn((request) => [
      geminiFunctionCall('scripted-edit', 'edit_file', {
        Path: join(projectPathFrom(request.userTexts[0] ?? ''), 'notes.txt'), Target: 'alpha', Replacement: 'beta',
      }),
    ]);
    testEnvironment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-edits', async (fixture) => {
      const project = fixture.executionDirs.project;
      await writeFile(join(project, 'notes.txt'), 'alpha line\n');
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: project, command: `edit files in PROJECT=${project}=PROJECT`, permissionMode: 'acceptEdits',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });

      expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('beta line\n');
      expect(await readFile(join(project, 'created.txt'), 'utf8')).toBe('created\n');
      const messages = (await fixture.client.getMessages(chatId)).messages;
      expect(messagesOfType(messages, 'read-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-read', filePath: join(project, 'notes.txt') }),
      ]);
      expect(messagesOfType(messages, 'write-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-write', filePath: join(project, 'created.txt'), content: 'created\n' }),
      ]);
      expect(messagesOfType(messages, 'edit-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-edit', oldString: 'alpha', newString: 'beta' }),
      ]);
      expect(messagesOfType(messages, 'unknown-tool-use')).toEqual([]);
      expect(messagesOfType(messages, 'permission-resolved')).toEqual([]);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  // The held response is released only after the assertions: whether agy aborts
  // the in-flight stream on cancel or the runtime replaces a process that does
  // not settle, the stopped turn must not deliver it.
  test('stops a running turn and continues the session', async () => {
    const testEnvironment = requireEnvironment();
    const held = testEnvironment.model.scriptHeldTurn([geminiText('never delivered')]);
    const reply = marker('AFTER_STOP');
    testEnvironment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-stop', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'start a long turn',
      }));
      await held.requested;
      const sessionId = await antigravityAgentSessionId(fixture, chatId);

      const stopCursor = fixture.client.markEvents();
      expect((await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() })).outcome)
        .toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS });

      const nextCursor = fixture.client.markEvents();
      const next = await fixture.client.runChat(scriptedAntigravityRunRequest({ chatId, command: 'continue after stop' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: reply, afterIndex: nextCursor });
      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual([reply]);
      expect(fixture.client.eventsSince(cursor).some((event) => event.type === 'chat-messages'
        && event.messages.some((entry) => entry.message.type === 'assistant-message'
          && entry.message.content.includes('never delivered')))).toBe(false);
      held.release();
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('fails the turn when the model API rejects the request', async () => {
    const testEnvironment = requireEnvironment();
    testEnvironment.model.scriptFault({
      kind: 'http-error', status: 400, message: 'Scripted request rejected.', reason: 'INVALID_ARGUMENT',
    });

    await withIntegrationFixture('antigravity-scripted-executor-error', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'trigger the model error',
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-failed');

      const messages = (await fixture.client.getMessages(chatId)).messages;
      const errors = messagesOfType(messages, 'error').map((message) => message.content);
      expect(errors).toEqual([expect.stringContaining('Scripted request rejected.')]);
      expect(assistantContents(messages)).toEqual([]);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('resumes the native session after a server restart', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('RESTART_FIRST_PROMPT');
    const firstReply = marker('RESTART_FIRST_REPLY');
    const secondReply = marker('RESTART_SECOND_REPLY');
    testEnvironment.model.scriptTurn([geminiText(firstReply)]);
    testEnvironment.model.scriptTurn((request) => {
      expect(request.userTexts.some((text) => text.includes(firstPrompt))).toBe(true);
      return [geminiText(secondReply)];
    });

    await withIntegrationFixture('antigravity-scripted-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: firstPrompt,
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, marker: firstReply, afterIndex: firstCursor });
      const sessionId = await antigravityAgentSessionId(fixture, chatId);

      await fixture.restartGarcon();

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedAntigravityRunRequest({ chatId, command: 'after restart' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: second.turnId, marker: secondReply, afterIndex: secondCursor });
      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual([firstReply, secondReply]);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  // agy ignores the cwd passed to session/resume and keeps the directory
  // recorded with the conversation, so Garcon refuses to move the chat.
  test('refuses a project path update, which agy would not apply', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('PATH_REPLY');
    testEnvironment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-project-path', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'establish the session',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, marker: reply, afterIndex: cursor });

      const refused = await fixture.client.updateProjectPath({
        chatId, projectPath: fixture.executionDirs.workspace,
      }).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(GarconApiError);
      expect(refused).toMatchObject({ status: 422, body: { errorCode: 'PROJECT_PATH_UPDATE_UNSUPPORTED' } });
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ projectPath: fixture.executionDirs.project });
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);
});

// The edit test passes the execution project path through the prompt, since the
// fake model only sees what agy sends it.
function projectPathFrom(text: string): string {
  const match = text.match(/PROJECT=(.+?)=PROJECT/);
  if (!match) throw new Error('The prompt did not carry the project path.');
  return match[1]!;
}
