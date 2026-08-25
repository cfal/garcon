import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationDirectories } from '../../support/integration-fixture.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import {
  OPENCODE_TEST_MODEL,
  openCodeNativeSession,
  readOpenCodeSessionRows,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';

// Fork matrix against the real binary: a fork taken while the first model
// request is still held seeds only the committed prefix, a never-run chat
// forks as an unmaterialized child that starts fresh, a settled fork carries
// the materialized prefix, and a fork of a settled child preserves the chain.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode fork matrix', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('forks immediately after start while the first model request is held', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('IMMEDIATE_PROMPT');
    const reply = marker('IMMEDIATE_REPLY');
    const childPrompt = marker('IMMEDIATE_CHILD_PROMPT');
    const childReply = marker('IMMEDIATE_CHILD_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-fork-immediate', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await held.requested;

      const forkChatId = fixture.newChatId();
      try {
        await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
        const forkedWhileRunning = await fixture.client.getMessages(forkChatId);
        expect(userContents(forkedWhileRunning.messages)).toEqual([prompt]);
        expect(assistantContents(forkedWhileRunning.messages)).toEqual([]);
      } finally {
        held.release();
      }
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expect(assistantContents((await fixture.client.getMessages(forkChatId)).messages))
        .not.toContain(reply);

      // An unmaterialized fork seeds its committed prefix inline into the child's
      // first command, so the provider sees one user message carrying both.
      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(prompt);
        expect(request.lastUserText).toContain(childPrompt);
        return [chatCompletionsText(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId: forkChatId,
        command: childPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: child.turnId,
        marker: childReply,
        afterIndex: childCursor,
      });

      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([prompt, childPrompt]);
      expect(assistantContents(fork.messages)).toEqual([childReply]);
      const materialized = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'opencode',
      });
      expect(typeof materialized.agentSessionId).toBe('string');
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('forks a never-run chat as an unmaterialized child that starts fresh', async () => {
    const testEnvironment = requireEnvironment();
    const sourceChatId = String(Date.now() * 1_000 + 901);
    const childPrompt = marker('EMPTY_CHILD_PROMPT');
    const childReply = marker('EMPTY_CHILD_REPLY');

    await withIntegrationFixture('opencode-fork-empty', async (fixture) => {
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      expect((await fixture.client.getMessages(forkChatId)).messages).toEqual([]);

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toBe(childPrompt);
        expect(request.userTexts).toEqual([childPrompt]);
        return [chatCompletionsText(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId: forkChatId,
        command: childPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: child.turnId,
        marker: childReply,
        afterIndex: childCursor,
      });

      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([childPrompt]);
      expect(assistantContents(fork.messages)).toEqual([childReply]);
      const materialized = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'opencode',
      });
      expect(typeof materialized.agentSessionId).toBe('string');
      testEnvironment.model.assertSettled();
    }, {
      ...withScriptedOpenCode(),
      prepareWorkspace: async (directories) => {
        await prepareWorkspace(directories);
        await prepareEmptyChat(directories, sourceChatId);
      },
    });
  }, 120_000);

  test('forks immediately after the first turn settles and reforks the child', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('SETTLED_PROMPT');
    const reply = marker('SETTLED_REPLY');
    const reforkPrompt = marker('REFORK_PROMPT');
    const reforkReply = marker('REFORK_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-fork-settled', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      const sourceNative = await openCodeNativeSession(fixture, sourceChatId);
      expect(readOpenCodeSessionRows(sourceNative).messages.length).toBeGreaterThan(0);

      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([prompt]);
      expect(assistantContents(fork.messages)).toEqual([reply]);

      const reforkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId: forkChatId, chatId: reforkChatId });
      const reforkSeed = await fixture.client.getMessages(reforkChatId);
      expect(userContents(reforkSeed.messages)).toEqual([prompt]);
      expect(assistantContents(reforkSeed.messages)).toEqual([reply]);

      testEnvironment.model.scriptTurn((request) => {
        expect(request.userTexts).toEqual([prompt, reforkPrompt]);
        return [chatCompletionsText(reforkReply)];
      });
      const reforkCursor = fixture.client.markEvents();
      const reforkTurn = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId: reforkChatId,
        command: reforkPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: reforkChatId,
        turnId: reforkTurn.turnId,
        marker: reforkReply,
        afterIndex: reforkCursor,
      });
      expect(userContents((await fixture.client.getMessages(sourceChatId)).messages))
        .toEqual([prompt]);
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
    prepareWorkspace: (directories) => testEnvironment.prepareWorkspace(directories),
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

async function prepareWorkspace(directories: IntegrationDirectories): Promise<void> {
  await requireEnvironment().prepareWorkspace(directories);
}

async function prepareEmptyChat(
  directories: IntegrationDirectories,
  chatId: string,
): Promise<void> {
  await writeFile(
    join(directories.workspace, 'workspace-version.json'),
    JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
  );
  await writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
    version: 5,
    sessions: {
      [chatId]: {
        agentId: 'opencode',
        nativeSession: null,
        agentOwnershipEpoch: crypto.randomUUID(),
        agentSettingsById: {},
        projectPath: directories.project,
        tags: [],
        agentSessionId: null,
        nextForkOrdinal: 1,
        model: OPENCODE_TEST_MODEL,
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        lastReadAt: null,
        permissionMode: 'bypassPermissions',
        thinkingMode: 'none',
        carryOverSegments: [],
        nativeSeedReceipt: null,
        carryOverMigrationQuarantine: null,
      },
    },
  }));
}

function marker(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}
