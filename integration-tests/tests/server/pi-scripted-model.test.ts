import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ChatSessionCreatedMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  PI_TEST_MODEL,
  piNativeSession,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

// The real pinned Pi CLI runs the whole turn -- spawn, local tool execution, JSONL session
// persistence -- while the model behind it is a deterministic script. This suite locks the
// CURRENT transport's observable behavior before the RPC switch.
let environment: ScriptedPiTestEnvironment | undefined;

describe('Pi against a scripted model', () => {
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('creates the session identity before the first turn settles', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('FIRST_REPLY');
    const prompt = marker('FIRST_PROMPT');
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_first', 'bash', {
      command: `printf %s ${marker('TOOL')}`,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('pi-scripted-session-created', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      if (!turn.turnId) throw new Error('Pi start response omitted its turn id.');

      const created = await fixture.client.waitForEvent(
        (event): event is ChatSessionCreatedMessage =>
          event.type === 'chat-session-created' && event.chatId === chatId,
        'pi session created',
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(created.chatId).toBe(chatId);

      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(terminal.type);

      // Session identity must be established before the turn settles; the transcript and the
      // registry both expose it immediately after.
      const events = fixture.client.eventsSince(cursor);
      const createdIndex = events.findIndex((event) => event.type === 'chat-session-created');
      const terminalIndex = events.findIndex((event) =>
        event.type === 'agent-run-finished' && event.chatId === chatId);
      expect(createdIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(createdIndex);

      const native = await piNativeSession(fixture, chatId);
      expect(native.agentSessionId.length).toBeGreaterThan(0);
      // Locked explicitly: findPiSessionFileBySessionId, the transcript index source, and
      // fork all parse this shape.
      expect(native.path).toMatch(/\/\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+\.jsonl$/);
      const sessionDir = fixture.dirs.home.endsWith('/')
        ? fixture.dirs.home
        : `${fixture.dirs.home}/`;
      expect(native.path.startsWith(sessionDir)).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('streams tool use and results before the turn terminal events', async () => {
    const testEnvironment = requireEnvironment();
    const toolMarker = marker('TOOL_OUTPUT');
    const reply = marker('TOOL_TURN_REPLY');
    const command = `printf %s ${toolMarker}`;
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_tool_turn', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('pi-scripted-tool-turn', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('TOOL_TURN_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      if (!bash) throw new Error('Pi shell tool use was not rendered.');
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(toolMarker);

      // WS order contract: every chat-messages delivery for the turn precedes its terminal
      // events.
      const events = fixture.client.eventsSince(cursor);
      const lastMessages = events.map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === 'chat-messages' && event.chatId === chatId)
        .at(-1);
      const terminalIndex = events.findIndex((event) =>
        event.type === 'agent-run-finished' && event.chatId === chatId);
      if (!lastMessages) throw new Error('Turn delivered no chat-messages events.');
      expect(terminalIndex).toBeGreaterThan(lastMessages.index);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('accumulates transcript and preview across a second turn on the same session', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('RESUME_FIRST_PROMPT');
    const firstReply = marker('RESUME_FIRST_REPLY');
    const secondPrompt = marker('RESUME_SECOND_PROMPT');
    const secondReply = marker('RESUME_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('pi-scripted-resume', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      const nativeAfterFirst = await piNativeSession(fixture, chatId);
      const sizeAfterFirst = (await readFile(nativeAfterFirst.path)).length;

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        command: secondPrompt,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: { ownerId: 'pi', schemaVersion: 1, values: {} },
        model: PI_TEST_MODEL,
      });
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });

      const nativeAfterSecond = await piNativeSession(fixture, chatId);
      expect(nativeAfterSecond.path).toBe(nativeAfterFirst.path);
      expect(nativeAfterSecond.agentSessionId).toBe(nativeAfterFirst.agentSessionId);
      expect((await readFile(nativeAfterSecond.path)).length).toBeGreaterThan(sizeAfterFirst);

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, secondPrompt]);
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((content) => content.includes(firstReply))).toBe(true);
      expect(assistants.some((content) => content.includes(secondReply))).toBe(true);
      const preview = (await fixture.client.listChats()).sessions.find(
        (entry) => entry.id === chatId,
      )?.preview.lastMessage;
      expect(preview).toContain(secondReply);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('exposes the scripted model in the catalog and rejects the default model', async () => {
    const testEnvironment = requireEnvironment();
    await withIntegrationFixture('pi-scripted-catalog', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      const pi = catalog.agents.find((agent) => agent.id === 'pi');
      if (!pi) throw new Error('Pi agent was not listed in the catalog.');
      expect(pi.models.map((model) => model.value)).toContain(PI_TEST_MODEL);
      // Baseline capability; flips to true with the steering facet.
      expect((pi as { supportsSteering?: boolean }).supportsSteering ?? false).toBe(false);

      testEnvironment.model.scriptTurn([chatCompletionsText(marker('UNUSED_DEFAULT_REPLY'))]);
      await expect(fixture.client.startChat(scriptedPiStartRequest({
        chatId: fixture.newChatId(),
        projectPath: fixture.dirs.project,
        command: marker('DEFAULT_MODEL_PROMPT'),
        model: 'default',
      }))).rejects.toBeDefined();
      testEnvironment.model.reset();
    }, withScriptedPi());
  }, 120_000);

  test('generates chat titles through the unchanged single-query path', async () => {
    const testEnvironment = requireEnvironment();
    const title = marker('SCRIPTED_TITLE');
    // First scripted turn answers the chat's start turn; the second answers the title
    // single query (runSingleQuery uses --mode text --no-session --no-tools).
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('TITLE_TURN_REPLY'))]);
    testEnvironment.model.scriptTurn([chatCompletionsText(title)]);

    await withIntegrationFixture('pi-scripted-title', async (fixture) => {
      // Explicit target with auto-generation disabled: only the explicit call below runs the
      // single query, so the scripted turn is consumed deterministically.
      await fixture.client.updateSettings({
        ui: {
          chatTitle: {
            enabled: false,
            agentId: 'pi',
            model: PI_TEST_MODEL,
            apiProviderId: null,
            modelEndpointId: null,
            modelProtocol: null,
            thinkingMode: 'none',
          },
        },
      });
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('TITLE_SOURCE_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        afterIndex: cursor,
      });
      const generated = await fixture.client.generateChatTitle({
        chatId,
        message: 'A conversation about scripted pi titles.',
      });
      expect(generated.success).toBe(true);
      const entry = (await fixture.client.listChats()).sessions.find(
        (session) => session.id === chatId,
      );
      expect(entry?.title).toContain(title);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);
});

function requireEnvironment(): ScriptedPiTestEnvironment {
  if (!environment) throw new Error('Scripted Pi environment was not initialized.');
  return environment;
}

function withScriptedPi(): {
  serverEnvironment: Record<string, string>;
  prepareWorkspace: ScriptedPiTestEnvironment['prepareWorkspace'];
} {
  const testEnvironment = requireEnvironment();
  return {
    serverEnvironment: testEnvironment.serverEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
  };
}

function marker(label: string): string {
  return `SCRIPTED_PI_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
