import { describe, expect, test } from 'bun:test';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const CARRIED_CONTEXT_MARKER = '<carried-context version="1"';

interface RecordedProviderRequest {
  readonly lastUserText: string;
}

interface HeldProviderRequest {
  readonly received: Promise<RecordedProviderRequest>;
  releaseText(content: string): boolean;
}

interface HoldableProvider {
  holdNext(matcher: { model?: string }): HeldProviderRequest;
}

interface PersistedChatEntry {
  readonly agentId: string;
  readonly agentOwnershipEpoch: string;
  readonly carryOverHeadId: string | null;
  readonly agentSessionId: string | null;
  readonly nativeSession: {
    readonly value?: { readonly path?: string };
  } | null;
}

interface CarryOverManifest {
  readonly kind: 'materialized' | 'prefix';
  readonly id: string;
  readonly parentId: string | null;
  readonly sourceNodeId?: string;
  readonly messageCount: number;
  readonly seedSanitation?: string;
}

describe('repeated agent handoff lifecycle', () => {
  test('preserves a linked A to B to A to B history through restart and an archived point fork', async () => {
    await withIntegrationFixture('repeated-agent-handoff', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const agentA = fixture.directAgents.openAi;
      const agentB = fixture.directAgents.anthropic;

      const initial = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'a-source',
        projectPath: fixture.dirs.project,
        agent: agentA,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, initial.turnId);
      const initialEntry = await readRegistryEntry(fixture, sourceChatId);
      const initialNativePath = requiredNativePath(initialEntry);
      await access(initialNativePath);

      const firstHandoffRequest = await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId: sourceChatId,
        agent: agentB,
        prompt: 'b-first',
        answer: 'b-first-answer',
      });
      expectSeed(firstHandoffRequest, {
        prompt: 'b-first',
        included: ['a-source'],
      });
      await waitForMissingFile(initialNativePath);

      const afterFirstHandoff = await readRegistryEntry(fixture, sourceChatId);
      expect(afterFirstHandoff.agentId).toBe(agentB.agentId);
      expect(afterFirstHandoff.agentOwnershipEpoch).not.toBe(initialEntry.agentOwnershipEpoch);
      const firstHead = requiredHead(afterFirstHandoff);
      const firstManifest = await readManifest(fixture, firstHead);
      expect(firstManifest).toMatchObject({
        kind: 'materialized',
        parentId: null,
        messageCount: 2,
        seedSanitation: 'not-applicable',
      });

      const bFollow = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'b-follow',
        agent: agentB,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, bFollow.turnId);
      const bNativePath = requiredNativePath(await readRegistryEntry(fixture, sourceChatId));
      await access(bNativePath);

      const secondHandoffRequest = await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.openAi,
        chatId: sourceChatId,
        agent: agentA,
        prompt: 'a-return',
        answer: 'a-return-answer',
      });
      expectSeed(secondHandoffRequest, {
        prompt: 'a-return',
        included: ['a-source', 'b-first', 'b-follow'],
      });
      await waitForMissingFile(bNativePath);

      const afterSecondHandoff = await readRegistryEntry(fixture, sourceChatId);
      expect(afterSecondHandoff.agentId).toBe(agentA.agentId);
      expect(afterSecondHandoff.agentOwnershipEpoch).not.toBe(
        afterFirstHandoff.agentOwnershipEpoch,
      );
      const secondHead = requiredHead(afterSecondHandoff);
      expect(secondHead).not.toBe(firstHead);
      expect(await readManifest(fixture, secondHead)).toMatchObject({
        kind: 'materialized',
        parentId: firstHead,
        messageCount: 4,
        seedSanitation: 'stripped-exact',
      });

      await fixture.crashAndRestartGarcon();
      await expectHistory(fixture, sourceChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return'],
        assistants: [
          'echo:a-source',
          'b-first-answer',
          'echo:b-follow',
          'a-return-answer',
        ],
        switches: [
          [agentA.agentId, agentB.agentId],
          [agentB.agentId, agentA.agentId],
        ],
      });

      const aFollow = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'a-follow',
        agent: agentA,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, aFollow.turnId);
      const aReturnNativePath = requiredNativePath(
        await readRegistryEntry(fixture, sourceChatId),
      );
      await access(aReturnNativePath);

      const thirdHandoffRequest = await handoffWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId: sourceChatId,
        agent: agentB,
        prompt: 'b-return',
        answer: 'b-return-answer',
      });
      expectSeed(thirdHandoffRequest, {
        prompt: 'b-return',
        included: ['a-source', 'b-first', 'b-follow', 'a-return', 'a-follow'],
      });
      await waitForMissingFile(aReturnNativePath);

      const afterThirdHandoff = await readRegistryEntry(fixture, sourceChatId);
      expect(afterThirdHandoff.agentId).toBe(agentB.agentId);
      expect(afterThirdHandoff.agentOwnershipEpoch).not.toBe(
        afterSecondHandoff.agentOwnershipEpoch,
      );
      const thirdHead = requiredHead(afterThirdHandoff);
      expect(thirdHead).not.toBe(secondHead);
      expect(await readManifest(fixture, thirdHead)).toMatchObject({
        kind: 'materialized',
        parentId: secondHead,
        messageCount: 4,
        seedSanitation: 'stripped-exact',
      });
      expect(await nodeIds(fixture)).toHaveLength(3);

      const completeSource = await expectHistory(fixture, sourceChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return', 'a-follow', 'b-return'],
        assistants: [
          'echo:a-source',
          'b-first-answer',
          'echo:b-follow',
          'a-return-answer',
          'echo:a-follow',
          'b-return-answer',
        ],
        switches: [
          [agentA.agentId, agentB.agentId],
          [agentB.agentId, agentA.agentId],
          [agentA.agentId, agentB.agentId],
        ],
      });

      const cutoff = completeSource.messages.find(({ message }) => (
        message.type === 'assistant-message' && message.content === 'a-return-answer'
      ));
      if (!cutoff) throw new Error('Missing archived cutoff message');
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: forkChatId,
        upToSeq: cutoff.seq,
      });

      const forkEntry = await readRegistryEntry(fixture, forkChatId);
      expect(forkEntry).toMatchObject({
        agentId: agentB.agentId,
        agentSessionId: null,
      });
      const forkHead = requiredHead(forkEntry);
      expect(forkHead).not.toBe(thirdHead);
      expect(await readManifest(fixture, forkHead)).toMatchObject({
        kind: 'prefix',
        parentId: secondHead,
        sourceNodeId: thirdHead,
        messageCount: 2,
      });
      expect(await nodeIds(fixture)).toHaveLength(4);
      await expectHistory(fixture, forkChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return'],
        assistants: [
          'echo:a-source',
          'b-first-answer',
          'echo:b-follow',
          'a-return-answer',
        ],
        switches: [
          [agentA.agentId, agentB.agentId],
          [agentB.agentId, agentA.agentId],
        ],
      });

      await fixture.restartGarcon();
      expect(requiredHead(await readRegistryEntry(fixture, sourceChatId))).toBe(thirdHead);
      expect(requiredHead(await readRegistryEntry(fixture, forkChatId))).toBe(forkHead);

      const forkRequest = await runWithAnswer({
        fixture,
        provider: fixture.fakeProviders.anthropic,
        chatId: forkChatId,
        agent: agentB,
        prompt: 'fork-continuation',
        answer: 'fork-continuation-answer',
      });
      expectSeed(forkRequest, {
        prompt: 'fork-continuation',
        included: ['a-source', 'b-first', 'b-follow', 'a-return'],
        excluded: ['a-follow', 'b-return'],
      });

      const sourceContinuation = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'source-continuation',
        agent: agentB,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, sourceContinuation.turnId);

      await expectHistory(fixture, sourceChatId, {
        users: [
          'a-source',
          'b-first',
          'b-follow',
          'a-return',
          'a-follow',
          'b-return',
          'source-continuation',
        ],
        assistants: [
          'echo:a-source',
          'b-first-answer',
          'echo:b-follow',
          'a-return-answer',
          'echo:a-follow',
          'b-return-answer',
          'echo:source-continuation',
        ],
        switches: [
          [agentA.agentId, agentB.agentId],
          [agentB.agentId, agentA.agentId],
          [agentA.agentId, agentB.agentId],
        ],
      });
      await expectHistory(fixture, forkChatId, {
        users: ['a-source', 'b-first', 'b-follow', 'a-return', 'fork-continuation'],
        assistants: [
          'echo:a-source',
          'b-first-answer',
          'echo:b-follow',
          'a-return-answer',
          'fork-continuation-answer',
        ],
        switches: [
          [agentA.agentId, agentB.agentId],
          [agentB.agentId, agentA.agentId],
        ],
      });

      await fixture.restartGarcon();
      expect(requiredHead(await readRegistryEntry(fixture, sourceChatId))).toBe(thirdHead);
      expect(requiredHead(await readRegistryEntry(fixture, forkChatId))).toBe(forkHead);
      expect(await nodeIds(fixture)).toHaveLength(4);

      const sourceNativePath = requiredNativePath(
        await readRegistryEntry(fixture, sourceChatId),
      );
      const forkNativePath = requiredNativePath(await readRegistryEntry(fixture, forkChatId));
      expect(await fixture.client.deleteChat(sourceChatId)).toEqual({ success: true });
      await waitForMissingFile(sourceNativePath);
      await waitForNodeCount(fixture, 4);
      expect(userContents((await fixture.client.getMessages(forkChatId)).messages)).toEqual([
        'a-source',
        'b-first',
        'b-follow',
        'a-return',
        'fork-continuation',
      ]);

      expect(await fixture.client.deleteChat(forkChatId)).toEqual({ success: true });
      await waitForMissingFile(forkNativePath);
      await waitForNodeCount(fixture, 0);
      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions).toEqual([]);
      expect(await nodeIds(fixture)).toEqual([]);
    });
  }, 45_000);
});

async function handoffWithAnswer(input: {
  fixture: IntegrationFixture;
  provider: HoldableProvider;
  chatId: string;
  agent: ConfiguredDirectTestAgent;
  prompt: string;
  answer: string;
}): Promise<RecordedProviderRequest> {
  const held = input.provider.holdNext({ model: input.agent.provider.model });
  const accepted = await input.fixture.client.handoffDirectChat({
    chatId: input.chatId,
    content: input.prompt,
    agent: input.agent,
  });
  const request = await held.received;
  expect(held.releaseText(input.answer)).toBe(true);
  const terminal = await input.fixture.client.waitForTurnTerminal(input.chatId, accepted.turnId);
  expect(terminal.type).toBe('agent-run-finished');
  return request;
}

async function runWithAnswer(input: {
  fixture: IntegrationFixture;
  provider: HoldableProvider;
  chatId: string;
  agent: ConfiguredDirectTestAgent;
  prompt: string;
  answer: string;
}): Promise<RecordedProviderRequest> {
  const held = input.provider.holdNext({ model: input.agent.provider.model });
  const accepted = await input.fixture.client.runDirectChat({
    chatId: input.chatId,
    content: input.prompt,
    agent: input.agent,
  });
  const request = await held.received;
  expect(held.releaseText(input.answer)).toBe(true);
  const terminal = await input.fixture.client.waitForTurnTerminal(input.chatId, accepted.turnId);
  expect(terminal.type).toBe('agent-run-finished');
  return request;
}

function expectSeed(
  request: RecordedProviderRequest,
  expected: {
    prompt: string;
    included: readonly string[];
    excluded?: readonly string[];
  },
): void {
  expect(request.lastUserText).toContain(expected.prompt);
  expect(occurrences(request.lastUserText, CARRIED_CONTEXT_MARKER)).toBe(1);
  for (const content of expected.included) expect(request.lastUserText).toContain(content);
  for (const content of expected.excluded ?? []) expect(request.lastUserText).not.toContain(content);
}

async function expectHistory(
  fixture: IntegrationFixture,
  chatId: string,
  expected: {
    users: string[];
    assistants: string[];
    switches: Array<[string, string]>;
  },
) {
  const history = await fixture.client.getMessages(chatId);
  expect(userContents(history.messages)).toEqual(expected.users);
  expect(assistantContents(history.messages)).toEqual(expected.assistants);
  expect(messagesOfType(history.messages, 'agent-switch').map((message) => [
    message.fromAgentId,
    message.toAgentId,
  ])).toEqual(expected.switches);
  return history;
}

async function readRegistryEntry(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<PersistedChatEntry> {
  const registry = JSON.parse(
    await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
  ) as { sessions?: Record<string, PersistedChatEntry> };
  const entry = registry.sessions?.[chatId];
  if (!entry) throw new Error(`Missing persisted chat ${chatId}`);
  return entry;
}

function requiredNativePath(entry: PersistedChatEntry): string {
  const nativePath = entry.nativeSession?.value?.path;
  if (!nativePath) throw new Error('Chat has no persisted native path');
  return nativePath;
}

function requiredHead(entry: PersistedChatEntry): string {
  if (!entry.carryOverHeadId) throw new Error('Chat has no carryover head');
  return entry.carryOverHeadId;
}

async function readManifest(
  fixture: IntegrationFixture,
  nodeId: string,
): Promise<CarryOverManifest> {
  return JSON.parse(await readFile(join(
    fixture.dirs.workspace,
    'carryover-transcripts',
    'nodes',
    nodeId,
    'manifest.json',
  ), 'utf8')) as CarryOverManifest;
}

async function nodeIds(fixture: IntegrationFixture): Promise<string[]> {
  const entries = await readdir(join(
    fixture.dirs.workspace,
    'carryover-transcripts',
    'nodes',
  ), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function waitForMissingFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for released transcript ${filePath}`);
}

async function waitForNodeCount(
  fixture: IntegrationFixture,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let observed: string[] = [];
  while (Date.now() < deadline) {
    observed = await nodeIds(fixture);
    if (observed.length === expectedCount) return;
    await Bun.sleep(20);
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} carryover nodes; observed ${observed.join(', ')}`,
  );
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
