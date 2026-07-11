import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { migrateWorkspaceChatIds } from '../chat-id-migration.ts';
import { ChatRegistry } from '../store.ts';
import { commandLedgerKey, commandPayloadHash } from '../../commands/command-ledger.ts';

const SECONDS_ID = '1772710502';
const SECONDS_CANONICAL_ID = '1772710502000000';
const MILLISECONDS_ID = '1774634779935';
const MILLISECONDS_CANONICAL_ID = '1774634779935000';
const EXISTING_CANONICAL_ID = '1783725900000000';

const createdDirs = [];

async function tempWorkspace() {
  const workspaceDir = path.join(os.tmpdir(), `garcon-chat-id-migration-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  createdDirs.push(workspaceDir);
  return workspaceDir;
}

async function writeJson(workspaceDir, fileName, value) {
  const filePath = path.join(workspaceDir, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function chatEntry(model = 'opus') {
  return { agentId: 'claude', projectPath: '/project', tags: [], model };
}

afterEach(async () => {
  for (const directory of createdDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('workspace chat ID migration', () => {
  it('migrates seconds and milliseconds IDs with all persisted references', async () => {
    const workspaceDir = await tempWorkspace();
    await writeJson(workspaceDir, 'chats.json', {
      version: 2,
      sessions: {
        [SECONDS_ID]: chatEntry(),
        [MILLISECONDS_ID]: chatEntry('sonnet'),
        [EXISTING_CANONICAL_ID]: chatEntry('haiku'),
      },
    });
    await writeJson(workspaceDir, 'project-settings.json', {
      pinnedChatIds: [SECONDS_ID],
      normalChatIds: [MILLISECONDS_ID, EXISTING_CANONICAL_ID],
      archivedChatIds: [],
      chatNames: { [SECONDS_ID]: 'Seconds chat', [MILLISECONDS_ID]: 'Milliseconds chat' },
    });
    await writeJson(workspaceDir, 'chat-metadata.json', {
      version: 1,
      chats: {
        [SECONDS_ID]: { chatId: SECONDS_ID, firstMessage: 'seconds' },
        [MILLISECONDS_ID]: { chatId: MILLISECONDS_ID, firstMessage: 'milliseconds' },
      },
    });
    await writeJson(workspaceDir, 'chat-carryover.json', {
      version: 1,
      chats: { [MILLISECONDS_ID]: [{ agentId: 'claude', model: 'opus', messages: [], at: '2026-01-01T00:00:00.000Z' }] },
    });
    const payload = { chatId: MILLISECONDS_ID, sourceChatId: SECONDS_ID, command: 'continue' };
    await writeJson(workspaceDir, 'command-ledger.json', {
      version: 1,
      records: [{
        key: commandLedgerKey('fork-run', MILLISECONDS_ID, 'request-1'),
        commandType: 'fork-run',
        chatId: MILLISECONDS_ID,
        clientRequestId: 'request-1',
        payload,
        payloadHash: commandPayloadHash(payload),
        status: 'finished',
        acceptedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    await writeJson(workspaceDir, 'scheduled-tasks.json', {
      version: 1,
      revision: 1,
      tasks: [{ id: 'task-1', target: { type: 'existing-chat', chatId: SECONDS_ID } }],
    });
    await writeJson(workspaceDir, 'shared-chats.json', {
      version: 2,
      shares: { token: { shareToken: 'token', chatId: MILLISECONDS_ID } },
    });
    await writeJson(workspaceDir, 'shares/token.json', {
      shareToken: 'token',
      chatId: MILLISECONDS_ID,
      messages: [],
    });
    await writeJson(workspaceDir, `queues/${SECONDS_ID}.queue.json`, { entries: [] });
    const eventsDir = path.join(workspaceDir, 'chat-events');
    await fs.mkdir(eventsDir, { recursive: true });
    await fs.writeFile(path.join(eventsDir, `${MILLISECONDS_ID}.events.jsonl`), '{}\n', 'utf8');

    const result = await migrateWorkspaceChatIds(workspaceDir);

    expect(result.migratedChatIds).toEqual({
      [SECONDS_ID]: SECONDS_CANONICAL_ID,
      [MILLISECONDS_ID]: MILLISECONDS_CANONICAL_ID,
    });
    const chats = JSON.parse(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8'));
    expect(Object.keys(chats.sessions).sort()).toEqual([
      SECONDS_CANONICAL_ID,
      MILLISECONDS_CANONICAL_ID,
      EXISTING_CANONICAL_ID,
    ].sort());

    const settings = JSON.parse(await fs.readFile(path.join(workspaceDir, 'project-settings.json'), 'utf8'));
    expect(settings.pinnedChatIds).toEqual([SECONDS_CANONICAL_ID]);
    expect(settings.normalChatIds).toEqual([MILLISECONDS_CANONICAL_ID, EXISTING_CANONICAL_ID]);
    expect(settings.chatNames).toEqual({
      [SECONDS_CANONICAL_ID]: 'Seconds chat',
      [MILLISECONDS_CANONICAL_ID]: 'Milliseconds chat',
    });

    const metadata = JSON.parse(await fs.readFile(path.join(workspaceDir, 'chat-metadata.json'), 'utf8'));
    expect(metadata.chats[SECONDS_CANONICAL_ID].chatId).toBe(SECONDS_CANONICAL_ID);
    expect(metadata.chats[MILLISECONDS_CANONICAL_ID].chatId).toBe(MILLISECONDS_CANONICAL_ID);
    const carryOver = JSON.parse(await fs.readFile(path.join(workspaceDir, 'chat-carryover.json'), 'utf8'));
    expect(carryOver.chats[MILLISECONDS_CANONICAL_ID]).toHaveLength(1);

    const ledger = JSON.parse(await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8'));
    const migratedRecord = ledger.records[0];
    expect(migratedRecord.chatId).toBe(MILLISECONDS_CANONICAL_ID);
    expect(migratedRecord.payload).toMatchObject({
      chatId: MILLISECONDS_CANONICAL_ID,
      sourceChatId: SECONDS_CANONICAL_ID,
    });
    expect(migratedRecord.key).toBe(
      commandLedgerKey('fork-run', MILLISECONDS_CANONICAL_ID, 'request-1'),
    );
    expect(migratedRecord.payloadHash).toBe(commandPayloadHash(migratedRecord.payload));

    const scheduled = JSON.parse(await fs.readFile(path.join(workspaceDir, 'scheduled-tasks.json'), 'utf8'));
    expect(scheduled.tasks[0].target.chatId).toBe(SECONDS_CANONICAL_ID);
    const shares = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(shares.shares.token.chatId).toBe(MILLISECONDS_CANONICAL_ID);
    const snapshot = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shares/token.json'), 'utf8'));
    expect(snapshot.chatId).toBe(MILLISECONDS_CANONICAL_ID);
    expect(await fs.readFile(path.join(workspaceDir, `queues/${SECONDS_CANONICAL_ID}.queue.json`), 'utf8')).toContain('entries');
    expect(await fs.readFile(path.join(eventsDir, `${MILLISECONDS_CANONICAL_ID}.events.jsonl`), 'utf8')).toBe('{}\n');

    const secondRun = await migrateWorkspaceChatIds(workspaceDir);
    expect(secondRun).toEqual({ migratedChatIds: {}, changedFiles: [] });
  });

  it('rejects a migration that would overwrite a canonical registry key', async () => {
    const workspaceDir = await tempWorkspace();
    await writeJson(workspaceDir, 'chats.json', {
      version: 2,
      sessions: {
        [MILLISECONDS_ID]: chatEntry(),
        [MILLISECONDS_CANONICAL_ID]: chatEntry('sonnet'),
      },
    });
    const before = await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8');

    await expect(migrateWorkspaceChatIds(workspaceDir)).rejects.toThrow(
      `Chat ID migration collision in chats.json: ${MILLISECONDS_CANONICAL_ID}`,
    );
    expect(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8')).toBe(before);
  });

  it('does not reinterpret uncommon numeric lengths', async () => {
    const workspaceDir = await tempWorkspace();
    await writeJson(workspaceDir, 'chats.json', {
      version: 2,
      sessions: { '177463477993': chatEntry() },
    });

    expect(await migrateWorkspaceChatIds(workspaceDir)).toEqual({
      migratedChatIds: {},
      changedFiles: [],
    });
    const registry = new ChatRegistry(workspaceDir);
    await expect(registry.init()).rejects.toThrow(
      'Chat ID must be a valid 16-digit Unix-microsecond timestamp',
    );
  });
});
