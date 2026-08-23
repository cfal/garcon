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

interface RecordedProviderRequest {
  readonly lastUserText: string;
  readonly body: {
    readonly messages?: readonly { readonly content: unknown }[];
  };
}

describe('agent switch compaction', () => {
  test('sends one visible compacted summary to a fresh Direct destination', async () => {
    await withIntegrationFixture('compaction-summary', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source);
      await enableCompaction(fixture, source);
      const observer = await fixture.connectObserver('summary-observer');

      const compactionCall = fixture.fakeProviders.openAi.holdNext({
        model: source.provider.model,
      });
      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on',
        agent: target,
      });

      const compactionPrompt = (await compactionCall.received).lastUserText;
      expect(compactionPrompt).toContain('turn-0');
      expect(compactionPrompt).toContain(target.agentId);
      expect(compactionPrompt).not.toContain('turn-4');
      expect(compactionCall.releaseText(`<summary>${SUMMARY}</summary>`)).toBeTrue();

      const targetRequest = await targetCall.received;
      const seededInput = expectedCompactedInput(SUMMARY, 'carry on');
      expect(targetRequest.lastUserText).toBe(seededInput);
      expect(requestConversation(targetRequest)).toEqual([seededInput]);
      expect(targetCall.releaseText('target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);

      assertOneHandoffNotice(await fixture.client.getMessages(chatId), SUMMARY, 'carry on');
      await observer.disconnect();
      await observer.reconnect();
      assertOneHandoffNotice(await observer.getMessages(chatId), SUMMARY, 'carry on');

      await fixture.restartGarcon();
      assertOneHandoffNotice(await fixture.client.getMessages(chatId), SUMMARY, 'carry on');

      const followCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const follow = fixture.client.runDirectChat({
        chatId,
        content: 'after restart',
        agent: target,
      });
      const followRequest = await followCall.received;
      expect(requestConversation(followRequest)).toEqual([
        seededInput,
        'target answer',
        'after restart',
      ]);
      expect(followCall.releaseText('follow answer')).toBeTrue();
      const followAccepted = await follow;
      await fixture.client.waitForTurnTerminal(chatId, followAccepted.turnId);
      assertOneHandoffNotice(await fixture.client.getMessages(chatId), SUMMARY, 'carry on');
    });
  }, 90_000);

  test('sends deterministic carried context and no notice while compaction is disabled', async () => {
    await withIntegrationFixture('compaction-disabled', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source);
      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on',
        agent: target,
      });

      const targetRequest = await targetCall.received;
      const seededInput = expectedFallbackInput('carry on');
      expect(targetRequest.lastUserText).toBe(seededInput);
      expect(requestConversation(targetRequest)).toEqual([seededInput]);
      expect(seededInput).not.toContain('<summary>');
      expect(targetCall.releaseText('target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      expect(handoffNotices((await fixture.client.getMessages(chatId)).messages)).toEqual([]);
    });
  }, 90_000);

  test('falls back without a notice for every invalid compactor result', async () => {
    await withIntegrationFixture('compaction-invalid-results', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      await enableCompaction(fixture, source);

      for (const [label, response] of [
        ['malformed', 'before <summary>summary</summary>'],
        ['empty', '<summary> \n </summary>'],
        ['duplicate', '<summary>first</summary><summary>second</summary>'],
        ['oversized', `<summary>${'x'.repeat(65_537)}</summary>`],
      ] as const) {
        const chatId = await seedDirectHistory(fixture, source);
        const compactionCall = fixture.fakeProviders.openAi.holdNext({
          model: source.provider.model,
        });
        const targetCall = fixture.fakeProviders.anthropic.holdNext({
          model: target.provider.model,
        });
        const prompt = `fallback-${label}`;
        const handoff = fixture.client.handoffDirectChat({ chatId, content: prompt, agent: target });

        await compactionCall.received;
        expect(compactionCall.releaseText(response)).toBeTrue();
        const targetRequest = await targetCall.received;
        expect(targetRequest.lastUserText).toBe(expectedFallbackInput(prompt));
        expect(targetCall.releaseText(`answer-${label}`)).toBeTrue();
        const accepted = await handoff;
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
        expect(handoffNotices((await fixture.client.getMessages(chatId)).messages)).toEqual([]);
      }
    });
  }, 120_000);

  test('stops held compaction before notice append or destination launch', async () => {
    await withIntegrationFixture('compaction-stop-before-launch', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source);
      await enableCompaction(fixture, source);
      const targetRequestCount = fixture.fakeProviders.anthropic.requests().length;
      const compactionCall = fixture.fakeProviders.openAi.holdNext({
        model: source.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'stop-before-provider-start',
        agent: target,
      });
      await compactionCall.received;
      await handoff;
      const compactionAborted = compactionCall.expectAbort();
      const eventCursor = fixture.client.markEvents();

      const stopped = await fixture.client.stopChat({
        chatId,
        clientRequestId: crypto.randomUUID(),
      });

      expect(stopped.outcome).toBe('interrupt-requested');
      await compactionAborted;
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: eventCursor });
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(targetRequestCount);
      expect(handoffNotices((await fixture.client.getMessages(chatId)).messages)).toEqual([]);
    });
  }, 90_000);

  test('compacts a native-to-Direct handoff', async () => {
    const environment: Record<string, string> = {};
    await withIntegrationFixture('compaction-native-to-direct', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is required.');
      const chatId = await seedClaudeHistory(fixture, claude);
      const compactor = fixture.directAgents.anthropic;
      const target = fixture.directAgents.openAi;
      await enableCompaction(fixture, compactor);
      const compactionCall = fixture.fakeProviders.anthropic.holdNext({
        model: compactor.provider.model,
      });
      const targetCall = fixture.fakeProviders.openAi.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'native to direct',
        agent: target,
      });

      await compactionCall.received;
      expect(compactionCall.releaseText(`<summary>${SUMMARY}</summary>`)).toBeTrue();
      const targetRequest = await targetCall.received;
      expect(targetRequest.lastUserText).toBe(expectedCompactedInput(SUMMARY, 'native to direct'));
      expect(targetCall.releaseText('direct target answer')).toBeTrue();
      const accepted = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      assertOneHandoffNotice(
        await fixture.client.getMessages(chatId),
        SUMMARY,
        'native to direct',
      );
    }, fakeClaudeOptions(environment));
  }, 90_000);

  test('compacts a Direct-to-native handoff', async () => {
    const environment: Record<string, string> = {};
    await withIntegrationFixture('compaction-direct-to-native', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is required.');
      const source = fixture.directAgents.openAi;
      const compactor = fixture.directAgents.anthropic;
      const chatId = await seedDirectHistory(fixture, source);
      await enableCompaction(fixture, compactor);
      const current = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId);
      if (!current) throw new Error('Direct source chat disappeared.');
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
        expectedCompactedInput(SUMMARY, 'direct to native'),
      );
      assertOneHandoffNotice(
        await fixture.client.getMessages(chatId),
        SUMMARY,
        'direct to native',
      );
    }, fakeClaudeOptions(environment));
  }, 90_000);
});

async function seedDirectHistory(
  fixture: IntegrationFixture,
  agent: ConfiguredDirectTestAgent,
): Promise<string> {
  const chatId = fixture.newChatId();
  const started = await fixture.client.startDirectChat({
    chatId,
    content: 'turn-0',
    projectPath: fixture.dirs.project,
    agent,
  });
  await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  for (const index of [1, 2, 3, 4]) {
    const accepted = await fixture.client.runDirectChat({ chatId, content: `turn-${index}`, agent });
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
): Promise<string> {
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
    command: 'turn-0',
  });
  await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  for (const index of [1, 2, 3, 4]) {
    const accepted = await fixture.client.runChat({
      clientRequestId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      chatId,
      command: `turn-${index}`,
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

function sourceConversation() {
  return [0, 1, 2, 3, 4].flatMap((index) => [
    new UserMessage('2026-01-01T00:00:00.000Z', `turn-${index}`),
    new AssistantMessage('2026-01-01T00:00:00.001Z', `echo:turn-${index}`),
  ]);
}

function expectedFallbackInput(prompt: string): string {
  return `${createCarryoverTranscript(
    sourceConversation(),
    CARRYOVER_INJECTION_MAX_CHARS,
  )!.prefix}${prompt}`;
}

function expectedCompactedInput(summary: string, prompt: string): string {
  return `${createCarryoverTranscript(
    sourceConversation().slice(4),
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
  const chat = await waitForPersistedNativeSession({
    directories,
    chatId,
    agentId: 'claude',
  });
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
