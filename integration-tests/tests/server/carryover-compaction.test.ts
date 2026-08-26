import { describe, expect, test } from 'bun:test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentSettingsEnvelope } from '../../../common/agent-integration.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  createCarryoverTranscript,
} from '../../../common/transcript-seed.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

const SUMMARY = 'Objective: ship the fix\n\n    Preserve the current verification plan.';
const SMALL_TURNS = Array.from({ length: 5 }, (_, index) => `turn-${index}`);

interface RecordedProviderRequest {
  readonly lastUserText: string;
  readonly body: {
    readonly messages?: readonly { readonly content: unknown }[];
  };
}

describe('agent switch compaction', () => {
  test('carries a small history in full without compaction or a summary notice', async () => {
    await withIntegrationFixture('compaction-small-history', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source, SMALL_TURNS);
      const sourceRequestCount = fixture.fakeProviders.openAi.requests().length;
      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on',
        agent: target,
      });

      const targetRequest = await targetCall.received;
      const seededInput = expectedCompleteInput(SMALL_TURNS, 'carry on');
      expect(targetRequest.lastUserText).toBe(seededInput);
      expect(requestConversation(targetRequest)).toEqual([seededInput]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(sourceRequestCount);
      expect(targetCall.releaseText('target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      expect(handoffNotices((await fixture.client.getMessages(chatId)).messages)).toEqual([]);
    });
  }, 90_000);

  test('retries one invalid result from the original history at a smaller budget', async () => {
    await withIntegrationFixture('compaction-retry', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const turns = largeTurns(12);
      const chatId = await seedDirectHistory(fixture, source, turns);
      await enableCompaction(fixture, source);
      const firstCall = fixture.fakeProviders.openAi.holdNext({ model: source.provider.model });
      const secondCall = fixture.fakeProviders.openAi.holdNext({ model: source.provider.model });
      const targetCall = fixture.fakeProviders.anthropic.holdNext({ model: target.provider.model });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on after retry',
        agent: target,
      });

      const firstPrompt = (await firstCall.received).lastUserText;
      expect(firstPrompt).toContain(largeTurnMarker(0));
      expect(firstPrompt).not.toContain(largeTurnMarker(turns.length - 1));
      expect(firstCall.releaseText('malformed summary')).toBeTrue();

      const secondPrompt = (await secondCall.received).lastUserText;
      expect(secondPrompt.length).toBeLessThan(firstPrompt.length);
      expect(secondPrompt).toContain(largeTurnMarker(0));
      expect(secondPrompt).not.toContain(largeTurnMarker(turns.length - 1));
      expect(secondCall.releaseText(`<summary>${SUMMARY}</summary>`)).toBeTrue();

      const targetRequest = await targetCall.received;
      const seededInput = expectedCompactedInput(turns, SUMMARY, 'carry on after retry');
      expect(targetRequest.lastUserText).toBe(seededInput);
      expect(requestConversation(targetRequest)).toEqual([seededInput]);
      expect(targetCall.releaseText('target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      assertOneHandoffNotice(
        await fixture.client.getMessages(chatId),
        SUMMARY,
        'carry on after retry',
      );
    });
  }, 120_000);

  test('requires compaction for a large history and succeeds after it is enabled', async () => {
    await withIntegrationFixture('compaction-required', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const turns = largeTurns(8);
      const chatId = await seedDirectHistory(fixture, source, turns);
      const before = await chatSummary(fixture, chatId);
      const beforeMessages = await fixture.client.getMessages(chatId, { limit: 200 });
      const beforeControl = await fixture.client.getExecutionControl(chatId);
      const targetRequestCount = fixture.fakeProviders.anthropic.requests().length;

      await expect(fixture.client.handoffDirectChat({
        chatId,
        content: 'compaction required',
        agent: target,
      })).rejects.toMatchObject({
        status: 422,
        body: {
          errorCode: 'CARRYOVER_COMPACTION_REQUIRED',
          error: expect.stringContaining('Enable agent-switch compaction in Settings'),
        },
      });

      expect(await chatSummary(fixture, chatId)).toEqual(before);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(beforeControl);
      expect((await fixture.client.getMessages(chatId, { limit: 200 })).messages)
        .toEqual(beforeMessages.messages);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(targetRequestCount);

      await enableCompaction(fixture, source);
      const compactionCall = fixture.fakeProviders.openAi.holdNext({ model: source.provider.model });
      const targetCall = fixture.fakeProviders.anthropic.holdNext({ model: target.provider.model });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'compaction required',
        agent: target,
      });
      await compactionCall.received;
      expect(compactionCall.releaseText(`<summary>${SUMMARY}</summary>`)).toBeTrue();
      await targetCall.received;
      expect(targetCall.releaseText('target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      expect((await chatSummary(fixture, chatId)).agentId).toBe(target.agentId);
    });
  }, 120_000);

  test('stops after two provider failures without changing ownership or transcript', async () => {
    await withIntegrationFixture('compaction-double-failure', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source, largeTurns(8));
      await enableCompaction(fixture, source);
      const before = await chatSummary(fixture, chatId);
      const beforeMessages = await fixture.client.getMessages(chatId, { limit: 200 });
      const beforeControl = await fixture.client.getExecutionControl(chatId);
      const sourceRequestCount = fixture.fakeProviders.openAi.requests().length;
      const targetRequestCount = fixture.fakeProviders.anthropic.requests().length;
      fixture.fakeProviders.openAi.failNextHttp(
        { model: source.provider.model },
        503,
        'synthetic first compaction failure',
      );
      fixture.fakeProviders.openAi.failNextHttp(
        { model: source.provider.model },
        503,
        'synthetic second compaction failure',
      );

      await expect(fixture.client.handoffDirectChat({
        chatId,
        content: 'must fail closed',
        agent: target,
      })).rejects.toMatchObject({
        status: 502,
        body: {
          errorCode: 'CARRYOVER_COMPACTION_FAILED',
          error: expect.stringContaining('failed after two attempts'),
        },
      });

      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(sourceRequestCount + 2);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(targetRequestCount);
      expect(await chatSummary(fixture, chatId)).toEqual(before);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(beforeControl);
      expect((await fixture.client.getMessages(chatId, { limit: 200 })).messages)
        .toEqual(beforeMessages.messages);
      expect(handoffNotices(beforeMessages.messages)).toEqual([]);
    });
  }, 120_000);

  test('does not retry when a held compaction is cancelled', async () => {
    await withIntegrationFixture('compaction-stop-before-launch', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source, largeTurns(8));
      await enableCompaction(fixture, source);
      const before = await chatSummary(fixture, chatId);
      const beforeMessages = await fixture.client.getMessages(chatId, { limit: 200 });
      const sourceRequestCount = fixture.fakeProviders.openAi.requests().length;
      const targetRequestCount = fixture.fakeProviders.anthropic.requests().length;
      const compactionCall = fixture.fakeProviders.openAi.holdNext({ model: source.provider.model });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'stop-before-provider-start',
        agent: target,
      });
      const handoffResult = handoff.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      await compactionCall.received;
      const compactionAborted = compactionCall.expectAbort();

      const stopped = await fixture.client.stopChat({
        chatId,
        clientRequestId: crypto.randomUUID(),
      });

      expect(stopped.outcome).toBe('already-idle');
      await compactionAborted;
      expect((await handoffResult).error).toBeInstanceOf(Error);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(sourceRequestCount + 1);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(targetRequestCount);
      expect(await chatSummary(fixture, chatId)).toEqual(before);
      expect((await fixture.client.getMessages(chatId, { limit: 200 })).messages)
        .toEqual(beforeMessages.messages);
    });
  }, 120_000);

  test('compacts a large native-to-Direct handoff', async () => {
    const environment: Record<string, string> = {};
    await withIntegrationFixture('compaction-native-to-direct', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is required.');
      const turns = largeTurns(20);
      const chatId = await seedClaudeHistory(fixture, claude, turns);
      const compactor = fixture.directAgents.anthropic;
      const target = fixture.directAgents.openAi;
      await enableCompaction(fixture, compactor);
      const compactionCall = fixture.fakeProviders.anthropic.holdNext({
        model: compactor.provider.model,
      });
      const targetCall = fixture.fakeProviders.openAi.holdNext({ model: target.provider.model });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'native to direct',
        agent: target,
      });

      await compactionCall.received;
      expect(compactionCall.releaseText(`<summary>${SUMMARY}</summary>`)).toBeTrue();
      const targetRequest = await targetCall.received;
      expect(targetRequest.lastUserText).toBe(
        expectedCompactedInput(turns, SUMMARY, 'native to direct'),
      );
      expect(targetCall.releaseText('direct target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      assertOneHandoffNotice(await fixture.client.getMessages(chatId), SUMMARY, 'native to direct');
    }, fakeClaudeOptions(environment));
  }, 120_000);

  test('compacts a large Direct-to-native handoff', async () => {
    const environment: Record<string, string> = {};
    await withIntegrationFixture('compaction-direct-to-native', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is required.');
      const source = fixture.directAgents.openAi;
      const compactor = fixture.directAgents.anthropic;
      const turns = largeTurns(8);
      const chatId = await seedDirectHistory(fixture, source, turns);
      await enableCompaction(fixture, compactor);
      const current = await chatSummary(fixture, chatId);
      const compactionCall = fixture.fakeProviders.anthropic.holdNext({
        model: compactor.provider.model,
      });
      const handoff = fixture.client.runChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        command: 'direct to native',
        handoff: {
          expectedAgentOwnershipEpoch: current.agentOwnershipEpoch,
          target: {
            agentId: claude.id,
            model: claude.defaultModel,
            permissionMode: 'default',
            thinkingMode: 'none',
            agentSettings: claude.defaultSettings,
          },
        },
      });

      await compactionCall.received;
      expect(compactionCall.releaseText(`<summary>${SUMMARY}</summary>`)).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      expect(await currentClaudeUserInput(fixture.dirs, chatId)).toBe(
        expectedCompactedInput(turns, SUMMARY, 'direct to native'),
      );
      assertOneHandoffNotice(await fixture.client.getMessages(chatId), SUMMARY, 'direct to native');
    }, fakeClaudeOptions(environment));
  }, 120_000);
});

async function seedDirectHistory(
  fixture: IntegrationFixture,
  agent: ConfiguredDirectTestAgent,
  turns: readonly string[],
): Promise<string> {
  const [first, ...rest] = turns;
  if (!first) throw new Error('At least one turn is required.');
  const chatId = fixture.newChatId();
  const started = await fixture.client.startDirectChat({
    chatId,
    content: first,
    projectPath: fixture.dirs.project,
    agent,
  });
  await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  for (const content of rest) {
    const accepted = await fixture.client.runDirectChat({ chatId, content, agent });
    await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
  }
  return chatId;
}

async function seedClaudeHistory(
  fixture: IntegrationFixture,
  claude: {
    readonly id: string;
    readonly defaultModel: string;
    readonly defaultSettings: AgentSettingsEnvelope;
  },
  turns: readonly string[],
): Promise<string> {
  const [first, ...rest] = turns;
  if (!first) throw new Error('At least one turn is required.');
  const chatId = fixture.newChatId();
  const started = await fixture.client.startChat({
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId,
    agentId: claude.id,
    projectPath: fixture.dirs.project,
    model: claude.defaultModel,
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettings: claude.defaultSettings,
    command: first,
  });
  await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  for (const command of rest) {
    const accepted = await fixture.client.runChat({
      clientRequestId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      chatId,
      command,
      model: claude.defaultModel,
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettings: claude.defaultSettings,
    });
    await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
  }
  return chatId;
}

function enableCompaction(
  fixture: IntegrationFixture,
  agent: ConfiguredDirectTestAgent,
): Promise<unknown> {
  return fixture.client.updateSettings({
    ui: {
      agentSwitchCompaction: {
        enabled: true,
        contextWindowTokens: 200_000,
        agentId: agent.agentId,
        model: agent.provider.model,
        apiProviderId: agent.provider.providerId,
        modelEndpointId: agent.provider.endpointId,
        modelProtocol: agent.provider.protocol,
        thinkingMode: 'none',
      },
    },
  });
}

function largeTurns(count: number): string[] {
  return Array.from({ length: count }, (_, index) => (
    `synthetic-large-turn-${index}-${'界'.repeat(8_000)}`
  ));
}

function largeTurnMarker(index: number): string {
  return `synthetic-large-turn-${index}-`;
}

function sourceConversation(turns: readonly string[]) {
  return turns.flatMap((content) => [
    new UserMessage('2026-01-01T00:00:00.000Z', content),
    new AssistantMessage('2026-01-01T00:00:00.001Z', `echo:${content}`),
  ]);
}

function expectedCompleteInput(turns: readonly string[], prompt: string): string {
  return `${createCarryoverTranscript(sourceConversation(turns), 0)!.prefix}${prompt}`;
}

function expectedCompactedInput(
  turns: readonly string[],
  summary: string,
  prompt: string,
): string {
  return `${createCarryoverTranscript(
    sourceConversation(turns).slice(-6),
    CARRYOVER_INJECTION_MAX_CHARS,
    { summary },
  )!.prefix}${prompt}`;
}

function requestConversation(request: RecordedProviderRequest): string[] {
  return (request.body.messages ?? []).map((message) => messageText(message.content));
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('');
}

function handoffNotices(messages: Parameters<typeof messagesOfType>[0]) {
  return messagesOfType(messages, 'transcript-notice')
    .filter((message) => message.title === 'Handoff summary');
}

function assertOneHandoffNotice(
  page: Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>,
  summary: string,
  prompt: string,
): void {
  expect(handoffNotices(page.messages)).toEqual([
    expect.objectContaining({ title: 'Handoff summary', content: summary }),
  ]);
  const input = page.messages.find((entry) => (
    entry.message.type === 'user-message' && entry.message.content === prompt
  ));
  const notice = page.messages.find((entry) => (
    entry.message.type === 'transcript-notice' && entry.message.title === 'Handoff summary'
  ));
  if (!input || !notice) throw new Error('Handoff input or summary notice is missing.');
  expect(input.ordinal).toBeLessThan(notice.ordinal);
}

async function chatSummary(fixture: IntegrationFixture, chatId: string) {
  const chat = (await fixture.client.listChats()).sessions.find((candidate) => candidate.id === chatId);
  if (!chat) throw new Error(`Chat ${chatId} disappeared.`);
  return chat;
}

function fakeClaudeOptions(environment: Record<string, string>) {
  return {
    serverEnvironment: environment,
    async prepareWorkspace(directories: IntegrationDirectories) {
      const fakeModule = fileURLToPath(
        new URL('../../support/fake-claude-cli.ts', import.meta.url),
      );
      const binaryPath = join(directories.root, 'claude');
      await writeFile(
        binaryPath,
        `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fakeModule).href)};\n`,
      );
      await chmod(binaryPath, 0o755);
      environment.CLAUDE_BINARY = binaryPath;
      environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
      environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
    },
  };
}

async function currentClaudeUserInput(
  directories: IntegrationDirectories,
  chatId: string,
): Promise<string> {
  const chat = await waitForPersistedNativeSession({ directories, chatId, agentId: 'claude' });
  const path = chat.nativeSession?.value.path;
  if (typeof path !== 'string') throw new Error('Claude native transcript path is missing.');
  const records = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const user = records.find((record) => record.type === 'user');
  const message = user?.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Claude native user record is missing.');
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string') throw new Error('Claude native user content is invalid.');
  return content;
}
