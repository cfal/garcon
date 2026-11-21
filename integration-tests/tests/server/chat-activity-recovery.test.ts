import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { ToolResultMessage } from '../../../common/chat-types.js';
import type { JsonValue } from '../../../common/json.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { withIntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const faultOptions = {
  resolveServerEnvironment: dirs => ({
    BUN_OPTIONS: `--preload=${fileURLToPath(new URL('../../support/chat-activity-faults.ts', import.meta.url))}`,
    GARCON_TEST_ACTIVITY_FAULT_ROOT: dirs.root,
  }),
} satisfies IntegrationFixtureOptions;

test('read-fenced activity cannot block mandatory run settlement or leak admission', async () => {
  await withIntegrationFixture('activity-read-fence', async fixture => {
    const chatId = fixture.newChatId();
    const held = fixture.fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic fenced activity' });
    const started = await fixture.client.startDirectChat({
      chatId, content: 'Synthetic fenced activity', projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.anthropic,
    });
    await held.received;
    const db = new Database(join(fixture.dirs.workspace, 'transcript-ledgers', chatId, 'ledger.sqlite'));
    try {
      db.exec("UPDATE transcript_rows SET payload_json = 'invalid' WHERE kind = 'user-input'");
    } finally {
      db.close();
    }
    const readFailure = await rejectionOf(fixture.client.getMessages(chatId));
    expect(readFailure).toBeInstanceOf(Error);
    const cursor = fixture.client.markEvents();
    held.releaseEcho();
    expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor }))
      .toMatchObject({ type: 'agent-run-failed' });
    expect((await fixture.client.reconnectState([chatId])).processing).toEqual({ outcome: 'snapshot', chats: [] });
    const receipt = parseAgentTurnReceipt(await fixture.client.get(
      `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${started.turnId}`,
    ));
    expect(receipt.state).toBe('failed');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await rejectionOf(fixture.client.runDirectChat({
        chatId, content: 'Synthetic rejected retry', agent: fixture.directAgents.anthropic,
      }));
      expect(retry).toBeInstanceOf(Error);
      expect(String(retry)).not.toContain('Another chat turn already owns execution');
    }
    expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(1);
  });
}, 60_000);

test('a delayed launch rejection cannot restore status after completed-run queue acceptance', async () => {
  await withIntegrationFixture('activity-delayed-launch', async fixture => {
    const chatId = fixture.newChatId();
    const initial = await fixture.client.startDirectChat({
      chatId, content: 'Synthetic initial activity', projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.anthropic,
    });
    await fixture.client.waitForTurnTerminal(chatId, initial.turnId);
    const held = fixture.fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic delayed activity launch' });
    const release = join(fixture.executionDirs.root, 'activity-launch-release');
    try {
      const started = await fixture.client.runDirectChat({
        chatId, content: 'Synthetic delayed activity launch',
        agent: fixture.directAgents.anthropic,
      });
      await held.received;
      await fixture.client.enqueueNew(chatId, 'Synthetic retained queue tail');
      await fixture.client.pauseQueue(chatId);
      held.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe('complete');
      expect((await fixture.client.getExecutionControl(chatId)).queue.pause).not.toBeNull();
      await fixture.client.enqueueNew(chatId, 'Synthetic paused follow-up');
      expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBeNull();
      const cursor = fixture.client.markEvents();
      await writeFile(release, 'release');
      expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor }))
        .toMatchObject({ type: 'agent-run-failed' });
      expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.activityStatus).toBeNull();
      expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBeNull();
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries.map(entry => entry.content))
        .toEqual(['Synthetic retained queue tail', 'Synthetic paused follow-up']);
    } finally {
      await writeFile(release, 'release');
    }
  }, faultOptions);
}, 60_000);

test('restart recovers failed activity even when bounded text previews are unavailable', async () => {
  await withIntegrationFixture('activity-preview-independent', async fixture => {
    const chatId = fixture.newChatId();
    const held = fixture.fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic cold failure' });
    const started = await fixture.client.startDirectChat({
      chatId, content: 'Synthetic cold failure', projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.anthropic,
    });
    await held.received;
    held.releaseStreamError('Synthetic cold failure');
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.restartGarcon({ beforeStart: async () => {
      const store = new TranscriptLedgerStore(join(fixture.dirs.workspace, 'transcript-ledgers'));
      const ledger = new TranscriptLedgerService(store);
      try {
        const view = store.currentView(chatId);
        if (!view) throw new Error('Missing synthetic ledger view');
        store.append(chatId, view.viewId, Array.from({ length: 32 }, () => ({
          kind: 'notice', at: '2026-01-01T00:00:00Z', message: 'Synthetic notice', detail: {},
        })));
        expect(ledger.existingPreview(chatId)).toBeNull();
      } finally {
        ledger.close();
      }
      await rm(join(fixture.dirs.workspace, 'chat-metadata.json'));
    } });
    await waitFor(async () => (await fixture.client.listChats()).sessions
      .find(chat => chat.id === chatId)?.activityStatus === 'error', 'recovered activity');
    expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe('error');
    expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
  });
}, 60_000);

test('optional worker contention at restart leaves transcript reads and execution available', async () => {
  await withIntegrationFixture('activity-worker-contention', async fixture => {
    const chatId = fixture.newChatId();
    const started = await fixture.client.startDirectChat({
      chatId, content: 'Synthetic before contention', projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.anthropic,
    });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    const busy = join(fixture.executionDirs.root, 'activity-worker-busy');
    await fixture.restartGarcon({ beforeStart: () => writeFile(busy, 'busy') });
    await waitFor(async () => existsSync(join(fixture.executionDirs.root, 'activity-worker-busy-observed')), 'worker failure');
    await rm(busy);
    expect((await fixture.client.getMessages(chatId)).messages.length).toBeGreaterThan(0);
    const next = await fixture.client.runDirectChat({
      chatId, content: 'Synthetic after contention', agent: fixture.directAgents.anthropic,
    });
    expect(await fixture.client.waitForTurnTerminal(chatId, next.turnId)).toMatchObject({ type: 'agent-run-finished' });
    expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe('complete');
  }, faultOptions);
}, 60_000);

test('restart activity recovery accepts deeply nested valid transcript JSON', async () => {
  await withIntegrationFixture('activity-deep-json', async fixture => {
    const chatId = fixture.newChatId();
    const started = await fixture.client.startDirectChat({
      chatId, content: 'Synthetic before restart', projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.anthropic,
    });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.restartGarcon({ beforeStart: async () => {
      const store = new TranscriptLedgerStore(join(fixture.dirs.workspace, 'transcript-ledgers'));
      try {
        const view = store.currentView(chatId);
        if (!view) throw new Error('Missing synthetic ledger view');
        let nested: JsonValue = 'Synthetic leaf';
        for (let depth = 0; depth < 1_100; depth++) nested = [nested];
        const at = '2026-01-01T00:00:00Z';
        store.append(chatId, view.viewId, [{
          kind: 'provider-row', at, message: new ToolResultMessage(at, 'tool-1', { nested }, false),
        }]);
      } finally {
        store.close();
      }
    } });
    await waitFor(async () => (await fixture.client.listChats()).sessions
      .find(chat => chat.id === chatId)?.activityStatus === 'complete', 'deep JSON activity recovery');
    expect((await fixture.client.getMessages(chatId)).messages.length).toBeGreaterThan(0);
    const next = await fixture.client.runDirectChat({
      chatId, content: 'Synthetic after restart', agent: fixture.directAgents.anthropic,
    });
    expect(await fixture.client.waitForTurnTerminal(chatId, next.turnId)).toMatchObject({ type: 'agent-run-finished' });
  });
}, 60_000);

test('held replacement recovery cannot block terminal settlement or successor admission', async () => {
  await withIntegrationFixture('activity-replacement-held', async fixture => {
    const { client, executionDirs } = fixture;
    const chatId = fixture.newChatId();
    const started = await client.startChat({
      chatId, agentId: 'shell', model: 'notes-markdown', projectPath: executionDirs.project,
      permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
      clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: '# Synthetic before reload',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    const release = join(executionDirs.root, 'activity-worker-release');
    await writeFile(join(executionDirs.root, 'activity-worker-hold'), 'hold');
    try {
      await client.reloadChat(chatId);
      await waitFor(async () => existsSync(join(executionDirs.root, 'activity-worker-held')), 'held replacement recovery');
      for (const command of ['# Synthetic after reload', '# Synthetic successor']) {
        const next = await client.runChat({
          chatId, command, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        });
        expect(await client.waitForTurnTerminal(chatId, next.turnId, { timeoutMs: 5_000 }))
          .toMatchObject({ type: 'agent-run-finished' });
        const receipt = parseAgentTurnReceipt(await client.get(
          `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${next.turnId}`,
        ));
        expect(receipt.state).toBe('completed');
      }
      expect((await client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe('complete');
      await writeFile(release, 'release');
      await waitFor(async () => existsSync(join(executionDirs.root, 'activity-worker-released')), 'released replacement recovery');
      expect((await client.listChats()).sessions.find(chat => chat.id === chatId)?.activityStatus).toBe('complete');
      expect((await client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe('complete');
    } finally {
      await writeFile(release, 'release');
    }
  }, faultOptions);
}, 60_000);

async function waitFor(condition: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}
