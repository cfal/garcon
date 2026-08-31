import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCatalogEntry } from '../../../common/agents.js';
import type { ExecutionSettingsPatchResponse } from '../../../common/chat-command-contracts.js';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { codexAgentSettings, type CodexFastMode } from '../../support/live-codex.js';
import {
  waitForPersistedChat,
  waitForPersistedNativeSession,
} from '../../support/persisted-chat.js';

const FAKE_CODEX = fileURLToPath(new URL(
  '../../support/fake-codex-app-server.ts',
  import.meta.url,
));
const SYSTEM_PATH = `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

interface ServiceTierLogEntry {
  readonly method: string;
  readonly threadId: string;
  readonly model: string;
  readonly serviceTier: 'default' | 'priority' | null;
}

describe('Codex Fast mode fake App Server boundaries', () => {
  test('native forks use the command snapshot for Off, On, and target persistence', async () => {
    let tierLogPath = '';
    await withIntegrationFixture('codex-fast-mode-fake-fork', async (fixture) => {
      const codex = await codexAgent(fixture);
      const sourceChatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(startRequest(
        fixture,
        codex,
        sourceChatId,
        marker('FORK_SOURCE'),
        'on',
      ));
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        source.turnId,
        { afterIndex: sourceCursor },
      )).type).toBe('agent-run-finished');
      await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: sourceChatId,
        agentId: 'codex',
      });
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');

      const offTargetId = fixture.newChatId();
      const offFork = await fixture.client.forkChat({
        sourceChatId,
        chatId: offTargetId,
        agentSettings: codexAgentSettings('off'),
      });
      expect(offFork.chat.agentSettings).toEqual(codexAgentSettings('off'));
      expect(offFork.chat.parentChat).toMatchObject({
        chatId: sourceChatId,
        relation: 'fork',
      });
      await expectPersistedFastMode(fixture.dirs, offTargetId, 'off');

      const offCursor = fixture.client.markEvents();
      const offTurn = await fixture.client.runChat(runRequest(
        codex,
        offTargetId,
        marker('FORK_OFF_TARGET'),
      ));
      expect((await fixture.client.waitForTurnTerminal(
        offTargetId,
        offTurn.turnId,
        { afterIndex: offCursor },
      )).type).toBe('agent-run-finished');

      const onTargetId = fixture.newChatId();
      const onFork = await fixture.client.forkChat({
        sourceChatId,
        chatId: onTargetId,
        agentSettings: codexAgentSettings('on'),
      });
      expect(onFork.chat.agentSettings).toEqual(codexAgentSettings('on'));
      expect(onFork.chat.parentChat).toMatchObject({
        chatId: sourceChatId,
        relation: 'fork',
      });
      await expectPersistedFastMode(fixture.dirs, onTargetId, 'on');

      const onCursor = fixture.client.markEvents();
      const onTurn = await fixture.client.runChat(runRequest(
        codex,
        onTargetId,
        marker('FORK_ON_TARGET'),
      ));
      expect((await fixture.client.waitForTurnTerminal(
        onTargetId,
        onTurn.turnId,
        { afterIndex: onCursor },
      )).type).toBe('agent-run-finished');

      const entries = await waitForTierLog(tierLogPath, (observed) => (
        observed.filter((entry) => entry.method === 'thread/fork').length === 2
        && observed.filter((entry) => entry.method === 'turn/start').length === 3
      ));
      expect(entries.filter((entry) => entry.method === 'thread/fork')
        .map((entry) => entry.serviceTier)).toEqual(['default', 'priority']);
      expect(entries.filter((entry) => entry.method === 'turn/start')
        .map((entry) => entry.serviceTier)).toEqual(['priority', 'default', 'priority']);
      await expectPersistedFastMode(fixture.dirs, sourceChatId, 'on');
    }, {
      resolveServerEnvironment(directories) {
        tierLogPath = join(directories.root, 'codex-service-tiers.jsonl');
        return fakeCodexEnvironment({
          INTEGRATION_CODEX_FORK_JSONL: '1',
          INTEGRATION_CODEX_SERVICE_TIER_LOG: tierLogPath,
        });
      },
    });
  }, 30_000);

  test('holds terminal-triggered dequeue until an Off update is durable', async () => {
    let tierLogPath = '';
    let turnReleasePath = '';
    await withIntegrationFixture('codex-fast-mode-terminal-update', async (fixture) => {
      const codex = await codexAgent(fixture);
      const chatId = fixture.newChatId();
      const activeCursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(startRequest(
        fixture,
        codex,
        chatId,
        marker('ACTIVE_PRIORITY'),
        'on',
      ));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: activeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const queuedPrompt = marker('QUEUED_AFTER_OFF');
      const queued = await fixture.client.enqueueNew(chatId, queuedPrompt);
      expect(queued.control.queue.entries).toHaveLength(1);
      expect(queued.control.queue.entries[0]).not.toHaveProperty('agentSettings');

      const patched = await patchFastMode(fixture.client, chatId, 'off');
      expect(patched.agentSettings).toEqual(codexAgentSettings('off'));
      await expectPersistedFastMode(fixture.dirs, chatId, 'off');

      const entries = await waitForTierLog(tierLogPath, (observed) => (
        observed.filter((entry) => entry.method === 'turn/start').length >= 2
      ));
      const firstTurn = entries.findIndex((entry) => (
        entry.method === 'turn/start' && entry.serviceTier === 'priority'
      ));
      const update = entries.findIndex((entry) => (
        entry.method === 'thread/settings/update' && entry.serviceTier === 'default'
      ));
      const queuedTurn = entries.findIndex((entry, index) => (
        index > update && entry.method === 'turn/start' && entry.serviceTier === 'default'
      ));
      expect(firstTurn).toBeGreaterThanOrEqual(0);
      expect(update).toBeGreaterThan(firstTurn);
      expect(queuedTurn).toBeGreaterThan(update);

      const queuedTerminalCursor = fixture.client.markEvents();
      await writeFile(turnReleasePath, 'release');
      const queuedTerminal = await fixture.client.waitForTurnTerminal(
        chatId,
        undefined,
        { afterIndex: queuedTerminalCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(queuedTerminal.type).toBe('agent-run-finished');
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .toContain(queuedPrompt);
      expect(fixture.client.eventsSince(activeCursor)).toContainEqual(expect.objectContaining({
        type: 'agent-run-finished',
        chatId,
        turnId: active.turnId,
      }));
    }, {
      resolveServerEnvironment(directories) {
        tierLogPath = join(directories.root, 'codex-service-tiers.jsonl');
        turnReleasePath = join(directories.root, 'release-streaming-turn');
        return fakeCodexEnvironment({
          INTEGRATION_CODEX_COMPLETE_TURN_DURING_SETTINGS_UPDATE: '1',
          INTEGRATION_CODEX_SERVICE_TIER_LOG: tierLogPath,
          INTEGRATION_CODEX_STREAMING_TURN: '1',
          INTEGRATION_CODEX_TURN_RELEASE: turnReleasePath,
        });
      },
    });
  }, 30_000);

  test('retires a client whose settings notification is lost before persisting On', async () => {
    let tierLogPath = '';
    let turnReleasePath = '';
    await withIntegrationFixture('codex-fast-mode-dropped-confirmation', async (fixture) => {
      const codex = await codexAgent(fixture);
      const chatId = fixture.newChatId();
      const activeCursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(startRequest(
        fixture,
        codex,
        chatId,
        marker('AMBIGUOUS_UPDATE_SOURCE'),
        'off',
      ));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: activeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const patchCursor = fixture.client.markEvents();
      const patched = await patchFastMode(fixture.client, chatId, 'on');
      expect(patched.agentSettings).toEqual(codexAgentSettings('on'));
      await expectPersistedFastMode(fixture.dirs, chatId, 'on');
      const failed = await fixture.client.waitForEvent(
        (event): event is AgentRunFailedMessage => (
          event.type === 'agent-run-failed'
          && event.chatId === chatId
          && event.turnId === active.turnId
        ),
        'retired Codex turn after an unconfirmed settings update',
        { afterIndex: patchCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(failed.error).toContain('did not confirm the Fast mode update');

      const nextPrompt = marker('FRESH_PRIORITY_CLIENT');
      const nextCursor = fixture.client.markEvents();
      const next = await fixture.client.runChat(runRequest(codex, chatId, nextPrompt));
      await waitForTierLog(tierLogPath, (entries) => entries.some((entry) => (
        entry.method === 'turn/start' && entry.serviceTier === 'priority'
      )));
      await writeFile(turnReleasePath, 'release');
      expect((await fixture.client.waitForTurnTerminal(
        chatId,
        next.turnId,
        { afterIndex: nextCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      )).type).toBe('agent-run-finished');

      const entries = await readTierLog(tierLogPath);
      const update = entries.findIndex((entry) => (
        entry.method === 'thread/settings/update' && entry.serviceTier === 'priority'
      ));
      const resumed = entries.findIndex((entry, index) => (
        index > update && entry.method === 'thread/resume' && entry.serviceTier === 'priority'
      ));
      const nextTurn = entries.findIndex((entry, index) => (
        index > resumed && entry.method === 'turn/start' && entry.serviceTier === 'priority'
      ));
      expect(update).toBeGreaterThanOrEqual(0);
      expect(resumed).toBeGreaterThan(update);
      expect(nextTurn).toBeGreaterThan(resumed);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .toContain(nextPrompt);
    }, {
      resolveServerEnvironment(directories) {
        tierLogPath = join(directories.root, 'codex-service-tiers.jsonl');
        turnReleasePath = join(directories.root, 'release-streaming-turn');
        return fakeCodexEnvironment({
          INTEGRATION_CODEX_DROP_SETTINGS_NOTIFICATION: '1',
          INTEGRATION_CODEX_SERVICE_TIER_LOG: tierLogPath,
          INTEGRATION_CODEX_STREAMING_TURN: '1',
          INTEGRATION_CODEX_TURN_RELEASE: turnReleasePath,
        });
      },
    });
  }, 60_000);
});

function startRequest(
  fixture: IntegrationFixture,
  codex: AgentCatalogEntry,
  chatId: string,
  command: string,
  fastMode: CodexFastMode,
) {
  return {
    origin: 'interactive' as const,
    clientRequestId: randomUUID(),
    clientMessageId: randomUUID(),
    chatId,
    agentId: 'codex',
    projectPath: fixture.dirs.project,
    model: codex.defaultModel,
    permissionMode: 'default' as const,
    thinkingMode: 'none' as const,
    agentSettings: codexAgentSettings(fastMode),
    command,
  };
}

function runRequest(
  codex: AgentCatalogEntry,
  chatId: string,
  command: string,
) {
  return {
    clientRequestId: randomUUID(),
    clientMessageId: randomUUID(),
    chatId,
    command,
    permissionMode: 'default' as const,
    thinkingMode: 'none' as const,
    model: codex.defaultModel,
  };
}

function patchFastMode(
  client: GarconTestClient,
  chatId: string,
  mode: CodexFastMode,
): Promise<ExecutionSettingsPatchResponse> {
  return client.patch('/api/v1/chats/execution-settings', {
    chatId,
    agentSettingsPatch: { codexFastMode: mode },
  });
}

async function codexAgent(fixture: IntegrationFixture): Promise<AgentCatalogEntry> {
  const codex = (await fixture.client.listAgentCatalog()).agents.find((agent) => agent.id === 'codex');
  if (!codex) throw new Error('Codex integration is missing from the agent catalog');
  return codex;
}

function fakeCodexEnvironment(
  extra: Record<string, string>,
): Record<string, string> {
  return {
    GARCON_CODEX_CLI: FAKE_CODEX,
    PATH: SYSTEM_PATH,
    ...extra,
  };
}

async function expectPersistedFastMode(
  directories: IntegrationDirectories,
  chatId: string,
  expected: CodexFastMode,
): Promise<void> {
  await waitForPersistedChat({
    directories,
    chatId,
    timeoutMessage: `Chat ${chatId} did not persist Codex Fast mode ${expected}.`,
    select: (chat) => {
      const settingsById = record(chat.agentSettingsById);
      const settings = record(settingsById?.codex);
      const values = record(settings?.values);
      return values?.codexFastMode === expected ? true : null;
    },
  });
}

async function waitForTierLog(
  path: string,
  predicate: (entries: readonly ServiceTierLogEntry[]) => boolean,
): Promise<readonly ServiceTierLogEntry[]> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  let entries: readonly ServiceTierLogEntry[] = [];
  while (Date.now() < deadline) {
    entries = await readTierLog(path);
    if (predicate(entries)) return entries;
    await Bun.sleep(20);
  }
  throw new Error(`Codex service-tier log did not reach the expected state: ${JSON.stringify(entries)}`);
}

async function readTierLog(path: string): Promise<readonly ServiceTierLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!raw.trim()) return [];
  return raw.trimEnd().split('\n').map((line) => JSON.parse(line) as ServiceTierLogEntry);
}

function marker(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
