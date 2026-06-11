import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { CommandLedger } from '../command-ledger.js';

let workspaceDir;

beforeEach(async () => {
  workspaceDir = path.join(os.tmpdir(), `garcon-command-ledger-test-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('CommandLedger', () => {
  it('accepts a command and persists the ledger record', async () => {
    const ledger = new CommandLedger(workspaceDir);

    const result = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      payload: { command: 'hello' },
    });

    expect(result.kind).toBe('accepted');
    expect(result.record.commandType).toBe('agent-run');
    expect(result.record.chatId).toBe('chat-1');
    expect(result.record.clientRequestId).toBe('req-1');
    expect(result.record.turnId).toBe('turn-1');

    const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
    const persisted = JSON.parse(raw);
    expect(persisted.records).toHaveLength(1);
    expect(persisted.records[0]).toMatchObject({
      key: 'agent-run:chat-1:req-1',
      status: 'accepted',
    });
  });

  it('treats reordered equivalent payloads as duplicates', async () => {
    const ledger = new CommandLedger(workspaceDir);
    await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-original',
      payload: {
        command: 'hello',
        options: { model: 'opus', permissionMode: 'default' },
      },
    });

    const duplicate = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      turnId: 'turn-new',
      payload: {
        options: { permissionMode: 'default', model: 'opus' },
        command: 'hello',
      },
    });

    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.record.turnId).toBe('turn-original');
  });

  it('returns conflict when a clientRequestId is reused for different payload', async () => {
    const ledger = new CommandLedger(workspaceDir);
    await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payload: { command: 'first' },
    });

    const conflict = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payload: { command: 'second' },
    });

    expect(conflict.kind).toBe('conflict');
    expect(conflict.record.payload.command).toBe('first');
  });

  it('loads persisted records before duplicate detection', async () => {
    const first = new CommandLedger(workspaceDir);
    await first.accept({
      commandType: 'queue-enqueue',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      entryId: 'entry-1',
      payload: { content: 'queued' },
    });

    const second = new CommandLedger(workspaceDir);
    const duplicate = await second.accept({
      commandType: 'queue-enqueue',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      entryId: 'entry-2',
      payload: { content: 'queued' },
    });

    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.record.entryId).toBe('entry-1');
  });

  it('serializes concurrent accepts for the same key', async () => {
    const ledger = new CommandLedger(workspaceDir);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.accept({
        commandType: 'agent-run',
        chatId: 'chat-1',
        clientRequestId: 'req-1',
        payload: { command: 'hello' },
      })),
    );

    expect(results.filter((result) => result.kind === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(7);

    const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
    expect(JSON.parse(raw).records).toHaveLength(1);
  });

  it('updates and persists terminal state', async () => {
    const ledger = new CommandLedger(workspaceDir);
    const accepted = await ledger.accept({
      commandType: 'agent-stop',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payload: { chatId: 'chat-1' },
    });

    const updated = await ledger.update(accepted.record.key, { status: 'finished' });

    expect(updated?.status).toBe('finished');

    const reloaded = new CommandLedger(workspaceDir);
    const duplicate = await reloaded.accept({
      commandType: 'agent-stop',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payload: { chatId: 'chat-1' },
    });

    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.record.status).toBe('finished');
  });

  it('updates a record by command identity', async () => {
    const ledger = new CommandLedger(workspaceDir);
    await ledger.accept({
      commandType: 'chat-start',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payload: { chatId: 'chat-1' },
    });

    const updated = await ledger.updateCommand('chat-start', 'chat-1', 'req-1', {
      status: 'failed',
      error: 'startup failed',
    });

    expect(updated).toMatchObject({
      commandType: 'chat-start',
      status: 'failed',
      error: 'startup failed',
    });
  });

  it('does not overwrite blocked statuses', async () => {
    const ledger = new CommandLedger(workspaceDir);
    const accepted = await ledger.accept({
      commandType: 'chat-start',
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      payload: { chatId: 'chat-1' },
    });

    await ledger.update(accepted.record.key, { status: 'failed', error: 'startup failed' });
    const skipped = await ledger.updateUnlessStatus(accepted.record.key, ['failed'], { status: 'running' });

    expect(skipped).toMatchObject({
      status: 'failed',
      error: 'startup failed',
    });
  });
});
