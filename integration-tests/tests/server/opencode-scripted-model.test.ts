import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  OPENCODE_PLUGIN_SEED_FILES,
  OPENCODE_TEST_MODEL,
  OPENCODE_VERSION,
  openCodeNativeSession,
  openCodePaths,
  readOpenCodeSessionCount,
  readOpenCodeSessionRows,
  readSupervisorStates,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// The real pinned OpenCode binary runs the whole turn -- server, global SSE stream, prompt
// loop, local tool execution, SQLite persistence -- while the model behind it is a
// deterministic script. This suite locks the catalog, isolation, identity, tool, title, and
// multi-directory contracts at Garcon's public server boundary.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('OpenCode against a scripted model', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('lists only the fake model, rejects a non-catalog model, and keeps all provider paths inside the fixture', async () => {
    const testEnvironment = requireEnvironment();
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('ISOLATION_REPLY'))]);

    await withIntegrationFixture('opencode-scripted-catalog', async (fixture) => {
      // A poison project config must never influence the fake-only catalog: project config
      // discovery is disabled for the provider child.
      await writeFile(join(fixture.dirs.project, 'opencode.json'), JSON.stringify({
        enabled_providers: ['sentinel'],
        provider: { sentinel: { id: 'sentinel', name: 'Sentinel', models: {} } },
      }));

      const paths = openCodePaths(fixture.dirs);
      const rootPrefix = `${fixture.dirs.root}${sep}`;
      for (const value of Object.values(paths)) {
        expect(value.startsWith(rootPrefix)).toBe(true);
      }

      const catalog = await fixture.client.listAgentCatalog();
      const opencode = catalog.agents.find((agent) => agent.id === 'opencode');
      if (!opencode) throw new Error('OpenCode agent was not listed in the catalog.');
      expect(opencode.models.map((model) => model.value)).toEqual([OPENCODE_TEST_MODEL]);

      // A model outside the fake-only catalog can never reach a real provider: OpenCode
      // rejects the unknown provider and the turn fails without any model request.
      const rejectedChatId = fixture.newChatId();
      const rejectedCursor = fixture.client.markEvents();
      const rejected = await fixture.client.startChat({
        ...scriptedOpenCodeStartRequest({
          chatId: rejectedChatId,
          projectPath: fixture.dirs.project,
          command: marker('NON_CATALOG_PROMPT'),
        }),
        model: 'openai/gpt-5',
      });
      const rejectedTerminal = await fixture.client.waitForTurnTerminal(
        rejectedChatId,
        rejected.turnId,
        { afterIndex: rejectedCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(rejectedTerminal.type).toBe('agent-run-failed');
      expect(testEnvironment.model.requests()).toHaveLength(0);

      // One real turn through the pinned binary, then the isolation audit.
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('ISOLATION_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        afterIndex: cursor,
      });

      // The seeded plugin bootstrap stayed byte-identical and the npm trap stayed silent.
      for (const [name, contents] of Object.entries(OPENCODE_PLUGIN_SEED_FILES)) {
        expect(await readFile(join(paths.globalConfig, name), 'utf8')).toBe(contents);
      }
      expect(testEnvironment.model.otherRequests()).toEqual([]);

      // The managed-config redirect is empty and fixture-owned, and the explicit DB exists.
      expect(await readFile(join(paths.config), 'utf8')).toContain('garcon-fake');
      expect(readOpenCodeSessionCount(paths.database)).toBeGreaterThan(0);
      const supervisors = await readSupervisorStates(fixture.dirs);
      expect(supervisors).toHaveLength(1);
      expect(supervisors[0]).toMatchObject({ mode: 'direct', version: OPENCODE_VERSION });
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('creates native session identity before the first turn terminal', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('FIRST_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-scripted-session-created', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('FIRST_PROMPT'),
      }));
      if (!turn.turnId) throw new Error('OpenCode start response omitted its turn id.');

      const created = await fixture.client.waitForEvent(
        (event): event is ChatSessionCreatedMessage =>
          event.type === 'chat-session-created' && event.chatId === chatId,
        'opencode session created',
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(created.chatId).toBe(chatId);

      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(terminal.type);

      const events = fixture.client.eventsSince(cursor);
      const createdIndex = events.findIndex((event) => event.type === 'chat-session-created');
      const terminalIndex = events.findIndex((event) =>
        event.type === 'agent-run-finished' && event.chatId === chatId);
      expect(createdIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(createdIndex);

      const native = await openCodeNativeSession(fixture, chatId);
      expect(native.agentSessionId.length).toBeGreaterThan(0);
      expect(native.artificialPath).toBe(`!opencode:${native.agentSessionId}`);
      const rows = readOpenCodeSessionRows(native);
      expect(rows.messages.some((message) => message.data.role === 'user')).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('uses a provider-owned ordered user ID and exact Garcon prompt part ID', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('ORDERED_PROMPT');
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('ORDERED_REPLY'))]);
    const requestCursor = testEnvironment.model.markRequests();

    await withIntegrationFixture('opencode-scripted-ordered-ids', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        afterIndex: cursor,
      });

      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      const user = rows.messages.find((row) => row.data.role === 'user');
      const assistant = rows.messages.find((row) => row.data.role === 'assistant');
      const promptPart = rows.parts.find((row) => row.data.text === prompt);

      // OpenCode owns ordered message IDs; Garcon owns only the exact prompt part ID.
      expect(user?.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(promptPart?.id).toMatch(/^prt_[0-9a-f]{32}$/);
      expect(promptPart?.message_id).toBe(user?.id);
      expect(assistant?.data.parentID).toBe(user?.id);
      expect(assistant!.id > user!.id).toBe(true);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('streams shell tool use and result before terminal events', async () => {
    const testEnvironment = requireEnvironment();
    const toolMarker = marker('TOOL_OUTPUT');
    const reply = marker('TOOL_TURN_REPLY');
    const command = `printf %s ${toolMarker}`;
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_tool_turn', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-scripted-tool-turn', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      if (!bash) throw new Error('OpenCode shell tool use was not rendered.');
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(toolMarker);

      const events = fixture.client.eventsSince(cursor);
      const lastMessages = events.map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === 'chat-messages' && event.chatId === chatId)
        .at(-1);
      const terminalIndex = events.findIndex((event) =>
        event.type === 'agent-run-finished' && event.chatId === chatId);
      if (!lastMessages) throw new Error('Turn delivered no chat-messages events.');
      expect(terminalIndex).toBeGreaterThan(lastMessages.index);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('accumulates transcript and preview across a second turn', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('RESUME_FIRST_PROMPT');
    const firstReply = marker('RESUME_FIRST_REPLY');
    const secondPrompt = marker('RESUME_SECOND_PROMPT');
    const secondReply = marker('RESUME_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('opencode-scripted-resume', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      const nativeAfterFirst = await openCodeNativeSession(fixture, chatId);
      const rowsAfterFirst = readOpenCodeSessionRows(nativeAfterFirst);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: secondPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });

      const nativeAfterSecond = await openCodeNativeSession(fixture, chatId);
      expect(nativeAfterSecond.agentSessionId).toBe(nativeAfterFirst.agentSessionId);
      const rowsAfterSecond = readOpenCodeSessionRows(nativeAfterSecond);
      expect(rowsAfterSecond.messages.length).toBeGreaterThan(rowsAfterFirst.messages.length);

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
    }, withScriptedOpenCode());
  }, 120_000);

  test('generates a Garcon chat title through OpenCode singleQuery', async () => {
    const testEnvironment = requireEnvironment();
    const title = marker('SCRIPTED_TITLE');
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('TITLE_TURN_REPLY'))]);
    testEnvironment.model.scriptTurn([chatCompletionsText(title)]);

    await withIntegrationFixture('opencode-scripted-title', async (fixture) => {
      await fixture.client.updateSettings({
        ui: {
          chatTitle: {
            enabled: false,
            agentId: 'opencode',
            model: OPENCODE_TEST_MODEL,
            apiProviderId: null,
            modelEndpointId: null,
            modelProtocol: null,
            thinkingMode: 'none',
          },
        },
      });
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      const sessionsBeforeTitle = readOpenCodeSessionCount(
        openCodePaths(fixture.dirs).database,
      );

      const generated = await fixture.client.generateChatTitle({
        chatId,
        message: 'A conversation about scripted opencode titles.',
      });
      expect(generated.success).toBe(true);
      const entry = (await fixture.client.listChats()).sessions.find(
        (session) => session.id === chatId,
      );
      expect(entry?.title).toContain(title);
      // The temporary native session used by singleQuery was deleted.
      expect(readOpenCodeSessionCount(openCodePaths(fixture.dirs).database))
        .toBe(sessionsBeforeTitle);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('completes concurrent chats in two project directories without cross-attribution', async () => {
    const testEnvironment = requireEnvironment();
    const promptA = marker('DIR_A_PROMPT');
    const promptB = marker('DIR_B_PROMPT');
    const replyFor = (prompt: string) => `SCRIPTED_OPENCODE_REPLY::${prompt}`;
    const script = (request: { lastUserText: string }) => [
      chatCompletionsText(replyFor(request.lastUserText)),
    ];
    testEnvironment.model.scriptTurn(script);
    testEnvironment.model.scriptTurn(script);

    await withIntegrationFixture('opencode-scripted-two-directories', async (fixture) => {
      const projectA = join(fixture.dirs.project, 'a');
      const projectB = join(fixture.dirs.project, 'b');
      await mkdir(projectA, { recursive: true });
      await mkdir(projectB, { recursive: true });

      const chatA = fixture.newChatId();
      const chatB = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const [turnA, turnB] = await Promise.all([
        fixture.client.startChat(scriptedOpenCodeStartRequest({
          chatId: chatA,
          projectPath: projectA,
          command: promptA,
        })),
        fixture.client.startChat(scriptedOpenCodeStartRequest({
          chatId: chatB,
          projectPath: projectB,
          command: promptB,
        })),
      ]);
      await Promise.all([
        waitForVisibleResponse({
          fixture,
          chatId: chatA,
          turnId: turnA.turnId,
          marker: replyFor(promptA),
          afterIndex: cursor,
        }),
        waitForVisibleResponse({
          fixture,
          chatId: chatB,
          turnId: turnB.turnId,
          marker: replyFor(promptB),
          afterIndex: cursor,
        }),
      ]);

      const transcriptA = await fixture.client.getMessages(chatA);
      const transcriptB = await fixture.client.getMessages(chatB);
      expect(assistantContents(transcriptA.messages)).toEqual([replyFor(promptA)]);
      expect(assistantContents(transcriptB.messages)).toEqual([replyFor(promptB)]);
      expect(userContents(transcriptA.messages)).toEqual([promptA]);
      expect(userContents(transcriptB.messages)).toEqual([promptB]);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
