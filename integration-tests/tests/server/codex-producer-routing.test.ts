import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCatalogEntry } from '../../../common/agents.js';
import type { ServerWsMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadFromNativeHistory } from '../../support/live-agent.js';

const FAKE_CODEX = fileURLToPath(new URL(
  '../../support/fake-codex-app-server.ts',
  import.meta.url,
));
const SYSTEM_PATH = `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

describe('Codex producer routing', () => {
  test('persists a goal status response once and broadcasts it before the turn terminal', async () => {
    await withIntegrationFixture('codex-goal-status-routing', async (fixture) => {
      const codex = await codexAgent(fixture);
      const chatId = fixture.newChatId();
      const startedAt = fixture.client.markEvents();
      const started = await fixture.client.startChat(startRequest(
        fixture,
        codex,
        chatId,
        'establish the Codex session',
      ));
      await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: startedAt });

      const command = '/goal';
      const expected = 'No Codex goal is set.';
      const goalCursor = fixture.client.markEvents();
      const goal = await fixture.client.runChat(runRequest(codex, chatId, command));
      await fixture.client.waitForTurnTerminal(chatId, goal.turnId, { afterIndex: goalCursor });

      const liveEvents = fixture.client.eventsSince(goalCursor);
      const liveRows = chatRows(liveEvents, chatId).filter((entry) => (
        entry.message.type === 'user-message' || entry.message.type === 'assistant-message'
      ));
      expect(liveRows.map(messageIdentity)).toEqual([
        ['user-message', command],
        ['assistant-message', expected],
      ]);
      const responseEvent = liveEvents.findIndex((event) => (
        event.type === 'chat-messages'
        && event.chatId === chatId
        && event.messages.some((entry) => (
          entry.message.type === 'assistant-message' && entry.message.content === expected
        ))
      ));
      const terminalEvent = liveEvents.findIndex((event) => (
        (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
        && event.chatId === chatId
        && event.turnId === goal.turnId
      ));
      expect(responseEvent).toBeGreaterThanOrEqual(0);
      expect(terminalEvent).toBeGreaterThan(responseEvent);

      const stored = await fixture.client.getMessages(chatId);
      const commandIndex = stored.messages.findIndex((entry) => (
        entry.message.type === 'user-message' && entry.message.content === command
      ));
      expect(commandIndex).toBeGreaterThanOrEqual(0);
      expect(stored.messages.slice(commandIndex).map(messageIdentity)).toEqual([
        ['user-message', command],
        ['assistant-message', expected],
      ]);
      expect(assistantContents(stored.messages).filter((content) => content === expected)).toHaveLength(1);

      await fixture.restartGarcon();
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)
        .filter((content) => content === expected)).toHaveLength(1);
    }, {
      serverEnvironment: {
        GARCON_CODEX_CLI: FAKE_CODEX,
        PATH: SYSTEM_PATH,
      },
    });
  });

  test('denies an approval emitted by an interrupted client after its replacement starts', async () => {
    let controlDirectory = '';
    let turnReleasePath = '';
    await withIntegrationFixture('codex-stale-approval-routing', async (fixture) => {
      const codex = await codexAgent(fixture);
      const chatId = fixture.newChatId();
      const firstPrompt = `source-${randomUUID()}`;
      const first = await fixture.client.startChat(startRequest(
        fixture,
        codex,
        chatId,
        firstPrompt,
      ));
      await waitForAssistant(fixture, chatId, `codex-live2-${firstPrompt}`);

      const stopCursor = fixture.client.markEvents();
      expect(await fixture.client.stopChat({
        clientRequestId: randomUUID(),
        chatId,
      })).toMatchObject({ outcome: 'interrupt-requested' });
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor });

      const replacementPrompt = `replacement-${randomUUID()}`;
      const replacementCursor = fixture.client.markEvents();
      const replacement = await fixture.client.runChat(runRequest(codex, chatId, replacementPrompt));
      await waitForAssistant(fixture, chatId, `codex-live2-${replacementPrompt}`);

      const staleCommand = `echo stale-${randomUUID()}`;
      const controlName = 'stale-source-approval.request.json';
      await writeFile(join(controlDirectory, controlName), JSON.stringify({
        target: 'started',
        requestId: 7_001,
        command: staleCommand,
      }));

      try {
        const outcome = await waitForApprovalOutcome(
          fixture,
          join(controlDirectory, `${controlName}.response.json`),
          chatId,
          staleCommand,
          replacementCursor,
        );
        expect(outcome).toEqual({
          kind: 'denied',
          response: { result: { decision: 'decline' }, error: null },
        });

        const snapshot = await fixture.client.getChatSnapshot(chatId, 100);
        expect(JSON.stringify(snapshot.transientFeed.rows)).not.toContain(staleCommand);
        expect(JSON.stringify((await fixture.client.getMessages(chatId)).messages)).not.toContain(staleCommand);
        expect(JSON.stringify(fixture.client.eventsSince(replacementCursor))).not.toContain(staleCommand);
      } finally {
        await writeFile(turnReleasePath, 'release');
        await fixture.client.waitForTurnTerminal(chatId, replacement.turnId, {
          afterIndex: replacementCursor,
        });
      }

      expect(first.turnId).not.toBe(replacement.turnId);
    }, {
      resolveServerEnvironment(directories) {
        controlDirectory = join(directories.root, 'codex-routing-controls');
        turnReleasePath = join(directories.root, 'codex-turn-release');
        return {
          GARCON_CODEX_CLI: FAKE_CODEX,
          PATH: SYSTEM_PATH,
          INTEGRATION_CODEX_ROUTING_CONTROL_DIR: controlDirectory,
          INTEGRATION_CODEX_STREAMING_TURN: '1',
          INTEGRATION_CODEX_TURN_RELEASE: turnReleasePath,
        };
      },
      async prepareWorkspace() {
        await mkdir(controlDirectory, { recursive: true });
      },
    });
  }, 30_000);

  test('drops content emitted by the old native client after transcript replacement', async () => {
    let controlDirectory = '';
    let turnReleasePath = '';
    await withIntegrationFixture('codex-stale-content-routing', async (fixture) => {
      const codex = await codexAgent(fixture);
      const chatId = fixture.newChatId();
      const firstPrompt = `source-content-${randomUUID()}`;
      await fixture.client.startChat(startRequest(fixture, codex, chatId, firstPrompt));
      await waitForAssistant(fixture, chatId, `codex-live2-${firstPrompt}`);

      const stopCursor = fixture.client.markEvents();
      expect(await fixture.client.stopChat({
        clientRequestId: randomUUID(),
        chatId,
      })).toMatchObject({ outcome: 'interrupt-requested' });
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor });

      const replacedView = (await fixture.client.getMessages(chatId)).transcriptViewId;
      await reloadFromNativeHistory(fixture, chatId);
      expect((await fixture.client.getMessages(chatId)).transcriptViewId).not.toBe(replacedView);

      const replacementPrompt = `replacement-content-${randomUUID()}`;
      const replacementCursor = fixture.client.markEvents();
      const replacement = await fixture.client.runChat(runRequest(codex, chatId, replacementPrompt));
      await waitForAssistant(fixture, chatId, `codex-live2-${replacementPrompt}`);

      const staleContent = `stale-content-${randomUUID()}`;
      const currentContent = `current-content-${randomUUID()}`;
      const staleControl = 'stale-source.message.json';
      const currentControl = 'current-source.message.json';
      const acknowledgementCommand = `acknowledge-stale-${randomUUID()}`;
      const acknowledgementControl = 'stale-source-ack.request.json';
      await writeFile(join(controlDirectory, staleControl), JSON.stringify({
        target: 'started',
        content: staleContent,
      }));

      try {
        await waitForPath(join(controlDirectory, `${staleControl}.sent`));
        await writeFile(join(controlDirectory, acknowledgementControl), JSON.stringify({
          target: 'started',
          requestId: 7_002,
          command: acknowledgementCommand,
        }));
        expect(await waitForApprovalOutcome(
          fixture,
          join(controlDirectory, `${acknowledgementControl}.response.json`),
          chatId,
          acknowledgementCommand,
          replacementCursor,
        )).toEqual({
          kind: 'denied',
          response: { result: { decision: 'decline' }, error: null },
        });

        await writeFile(join(controlDirectory, currentControl), JSON.stringify({
          target: 'resumed',
          content: currentContent,
        }));
        await waitForPath(join(controlDirectory, `${currentControl}.sent`));
        await waitForAssistant(fixture, chatId, currentContent);

        const snapshot = await fixture.client.getChatSnapshot(chatId, 100);
        expect(JSON.stringify(snapshot.transientFeed.rows)).not.toContain(staleContent);
        expect(JSON.stringify((await fixture.client.getMessages(chatId)).messages))
          .not.toContain(staleContent);
        expect(JSON.stringify(fixture.client.eventsSince(replacementCursor)))
          .not.toContain(staleContent);
      } finally {
        await writeFile(turnReleasePath, 'release');
        await fixture.client.waitForTurnTerminal(chatId, replacement.turnId, {
          afterIndex: replacementCursor,
        });
      }
    }, {
      resolveServerEnvironment(directories) {
        controlDirectory = join(directories.root, 'codex-content-routing-controls');
        turnReleasePath = join(directories.root, 'codex-content-turn-release');
        return {
          GARCON_CODEX_CLI: FAKE_CODEX,
          PATH: SYSTEM_PATH,
          INTEGRATION_CODEX_ROUTING_CONTROL_DIR: controlDirectory,
          INTEGRATION_CODEX_STREAMING_TURN: '1',
          INTEGRATION_CODEX_TURN_RELEASE: turnReleasePath,
        };
      },
      async prepareWorkspace() {
        await mkdir(controlDirectory, { recursive: true });
      },
    });
  }, 30_000);
});

function startRequest(
  fixture: IntegrationFixture,
  codex: AgentCatalogEntry,
  chatId: string,
  command: string,
) {
  return {
    clientRequestId: randomUUID(),
    clientMessageId: randomUUID(),
    chatId,
    agentId: 'codex',
    projectPath: fixture.dirs.project,
    model: codex.defaultModel,
    permissionMode: 'default' as const,
    thinkingMode: 'none' as const,
    agentSettings: codex.defaultSettings,
    command,
  };
}

function runRequest(codex: AgentCatalogEntry, chatId: string, command: string) {
  return {
    clientRequestId: randomUUID(),
    clientMessageId: randomUUID(),
    chatId,
    command,
    permissionMode: 'default' as const,
    thinkingMode: 'none' as const,
    agentSettings: codex.defaultSettings,
    model: codex.defaultModel,
  };
}

async function codexAgent(fixture: IntegrationFixture): Promise<AgentCatalogEntry> {
  const codex = (await fixture.client.listAgentCatalog()).agents.find((agent) => agent.id === 'codex');
  if (!codex) throw new Error('Codex integration is missing from the agent catalog');
  return codex;
}

async function waitForAssistant(
  fixture: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let observed: string[] = [];
  while (Date.now() < deadline) {
    observed = assistantContents((await fixture.client.getMessages(chatId)).messages);
    if (observed.includes(content)) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${content}. Observed: ${JSON.stringify(observed)}`);
}

async function waitForApprovalOutcome(
  fixture: IntegrationFixture,
  responsePath: string,
  chatId: string,
  command: string,
  eventCursor: number,
): Promise<
  | { kind: 'denied'; response: unknown }
  | { kind: 'misrouted'; event: ServerWsMessage }
> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return {
        kind: 'denied',
        response: JSON.parse(await readFile(responsePath, 'utf8')) as unknown,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const event = fixture.client.eventsSince(eventCursor).find((candidate) => (
      candidate.type === 'chat-transient-feed-mutation'
      && candidate.chatId === chatId
      && candidate.mutation.kind === 'upsert'
      && JSON.stringify(candidate.mutation.row.message).includes(command)
    ));
    if (event) return { kind: 'misrouted', event };
    await Bun.sleep(10);
  }
  throw new Error(`Codex did not deny or publish the controlled approval: ${command}`);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function chatRows(events: readonly ServerWsMessage[], chatId: string) {
  return events.flatMap((event) => (
    event.type === 'chat-messages' && event.chatId === chatId ? event.messages : []
  ));
}

function messageIdentity(entry: {
  readonly message: { readonly type: string; readonly content?: unknown };
}): [string, unknown] {
  return [entry.message.type, entry.message.content ?? null];
}
