import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  CommandLedger,
  SERVER_RESTART_INTERRUPTED_ERROR_CODE,
} from '../command-ledger.js';

let workspaceDir;

function makeLedgerRecord(index) {
  const now = new Date(2026, 0, 1, 0, 0, index).toISOString();
  return {
    key: `agent-run:chat-1:req-${index}`,
    commandType: 'agent-run',
    chatId: 'chat-1',
    clientRequestId: `req-${index}`,
    payloadHash: 'legacy-hash',
    payload: { command: `cmd-${index}` },
    status: 'finished',
    acceptedAt: now,
    updatedAt: now,
  };
}

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

  it('stores attachment digests instead of base64 while preserving idempotency', async () => {
    const ledger = new CommandLedger(workspaceDir);
    const image = {
      name: 'large.png',
      mimeType: 'image/png',
      data: `data:image/png;base64,${'a'.repeat(20_000)}`,
    };

    await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-image',
      payload: { command: 'inspect', images: [image] },
    });
    const duplicate = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-image',
      payload: { command: 'inspect', images: [image] },
    });

    const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
    expect(raw).not.toContain(image.data);
    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.record.payload.images[0]).toMatchObject({
      name: 'large.png',
      mimeType: 'image/png',
      dataLength: image.data.length,
      dataSha256: expect.any(String),
    });
  });

  it('fails interrupted execution records when a new process loads the ledger', async () => {
    const first = new CommandLedger(workspaceDir);
    const accepted = await first.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-interrupted',
      payload: { command: 'long turn' },
    });
    await first.update(accepted.record.key, { status: 'scheduled' });

    const second = new CommandLedger(workspaceDir);
    const duplicate = await second.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-interrupted',
      payload: { command: 'long turn' },
    });

    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      record: {
        status: 'failed',
        errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
      },
    });
    expect(await second.listPendingInputRecoveries()).toEqual([
      expect.objectContaining({
        commandType: 'agent-run',
        clientRequestId: 'req-interrupted',
        pendingInputRecovery: 'required',
      }),
    ]);

    await expect(
      second.settlePendingInputRecovery('chat-1', 'req-interrupted'),
    ).resolves.toBe(true);
    const third = new CommandLedger(workspaceDir);
    await expect(third.listPendingInputRecoveries()).resolves.toEqual([]);
  });

  it('retains interrupted fork preparation until startup compensation settles it', async () => {
    const first = new CommandLedger(workspaceDir);
    const accepted = await first.accept({
      commandType: 'fork-run',
      chatId: 'fork-target',
      clientRequestId: 'req-fork-interrupted',
      payload: { sourceChatId: 'fork-source', command: 'continue' },
    });
    await first.update(accepted.record.key, {
      forkPreparation: {
        phase: 'created',
        sourceChatId: 'fork-source',
        sourceNextForkOrdinal: 2,
      },
    });

    const restarted = new CommandLedger(workspaceDir);
    const interrupted = await restarted.listForkPreparationsPendingRecovery();

    expect(interrupted).toEqual([
      expect.objectContaining({
        key: accepted.record.key,
        status: 'failed',
        errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
        forkPreparation: {
          phase: 'created',
          sourceChatId: 'fork-source',
          sourceNextForkOrdinal: 2,
        },
      }),
    ]);
    await expect(restarted.settleForkPreparationRecovery(accepted.record.key)).resolves.toBe(true);
    await expect(restarted.listForkPreparationsPendingRecovery()).resolves.toEqual([]);
  });

  it('does not trim unresolved restart recovery records', async () => {
    const recoveryRecord = {
      ...makeLedgerRecord(-1),
      key: 'agent-run:chat-1:req-recovery',
      clientRequestId: 'req-recovery',
      status: 'failed',
      errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
      pendingInputRecovery: 'required',
    };
    await fs.writeFile(
      path.join(workspaceDir, 'command-ledger.json'),
      JSON.stringify({
        version: 1,
        records: [recoveryRecord, ...Array.from({ length: 1000 }, (_, index) => makeLedgerRecord(index))],
      }),
      'utf8',
    );

    const ledger = new CommandLedger(workspaceDir);
    const recovery = await ledger.listPendingInputRecoveries();

    expect(recovery).toEqual([
      expect.objectContaining({ clientRequestId: 'req-recovery', pendingInputRecovery: 'required' }),
    ]);
    const persisted = JSON.parse(await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8'));
    expect(persisted.records).toHaveLength(1000);
    expect(persisted.records.some((record) => record.clientRequestId === 'req-recovery')).toBe(true);
  });

  it('does not trim a newly accepted execution behind a full recovery backlog', async () => {
    const recoveries = Array.from({ length: 1000 }, (_, index) => ({
      ...makeLedgerRecord(index),
      status: 'failed',
      errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
      pendingInputRecovery: 'required',
    }));
    await fs.writeFile(
      path.join(workspaceDir, 'command-ledger.json'),
      JSON.stringify({ version: 1, records: recoveries }),
      'utf8',
    );
    const ledger = new CommandLedger(workspaceDir);

    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-new',
      clientRequestId: 'req-new',
      payload: { command: 'must survive trimming' },
    });

    expect(accepted.kind).toBe('accepted');
    const restarted = new CommandLedger(workspaceDir);
    await expect(restarted.listPendingInputRecoveries()).resolves.toContainEqual(
      expect.objectContaining({
        chatId: 'chat-new',
        clientRequestId: 'req-new',
        pendingInputRecovery: 'required',
      }),
    );
  });

  it('does not trim a restart-interrupted execution tombstone behind a full recovery backlog', async () => {
    const recoveries = Array.from({ length: 1000 }, (_, index) => ({
      ...makeLedgerRecord(index),
      status: 'failed',
      errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
      pendingInputRecovery: 'required',
    }));
    await fs.writeFile(
      path.join(workspaceDir, 'command-ledger.json'),
      JSON.stringify({ version: 1, records: recoveries }),
      'utf8',
    );
    const first = new CommandLedger(workspaceDir);
    const accepted = await first.accept({
      commandType: 'agent-compact',
      chatId: 'chat-new',
      clientRequestId: 'req-compact',
      payload: { chatId: 'chat-new' },
    });
    expect(accepted.kind).toBe('accepted');

    const restarted = new CommandLedger(workspaceDir);
    const duplicate = await restarted.accept({
      commandType: 'agent-compact',
      chatId: 'chat-new',
      clientRequestId: 'req-compact',
      payload: { chatId: 'chat-new' },
    });

    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      record: {
        status: 'failed',
        errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
      },
    });
  });

  it('does not evict an in-flight command under capacity pressure', async () => {
    const active = {
      ...makeLedgerRecord(-1),
      key: 'agent-stop:chat-1:req-active',
      commandType: 'agent-stop',
      clientRequestId: 'req-active',
      status: 'accepted',
    };
    await fs.writeFile(
      path.join(workspaceDir, 'command-ledger.json'),
      JSON.stringify({
        version: 1,
        records: [active, ...Array.from({ length: 1000 }, (_, index) => makeLedgerRecord(index))],
      }),
      'utf8',
    );
    const ledger = new CommandLedger(workspaceDir);

    await ledger.update(active.key, { status: 'scheduled' });

    const persisted = JSON.parse(await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8'));
    expect(persisted.records).toHaveLength(1000);
    expect(persisted.records).toContainEqual(expect.objectContaining({
      clientRequestId: 'req-active',
      status: 'scheduled',
    }));
  });

  it('migrates legacy live-failed user inputs into durable recovery', async () => {
    const failed = {
      ...makeLedgerRecord(1),
      status: 'failed',
      error: 'provider failed before persistence',
    };
    await fs.writeFile(
      path.join(workspaceDir, 'command-ledger.json'),
      JSON.stringify({ version: 1, records: [failed] }),
      'utf8',
    );

    const recovery = await new CommandLedger(workspaceDir).listPendingInputRecoveries();

    expect(recovery).toEqual([
      expect.objectContaining({
        clientRequestId: failed.clientRequestId,
        status: 'failed',
        pendingInputRecovery: 'required',
      }),
    ]);
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

  it('returns conflict when a request identity is reused across command types', async () => {
    const ledger = new CommandLedger(workspaceDir);
    await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-shared',
      payload: { command: 'first' },
    });

    const conflict = await ledger.accept({
      commandType: 'fork-run',
      chatId: 'chat-1',
      clientRequestId: 'req-shared',
      payload: { command: 'second' },
    });

    expect(conflict).toMatchObject({
      kind: 'conflict',
      record: { commandType: 'agent-run' },
    });
  });

  it('fails closed when the persisted ledger shape is malformed', async () => {
    const malformedFiles = [
      null,
      { version: 2, records: [] },
      { version: 1, records: {} },
      { version: 1, records: [{ ...makeLedgerRecord(1), status: 'mystery' }] },
      { version: 1, records: [{ ...makeLedgerRecord(1), payload: null }] },
      { version: 1, records: [{ ...makeLedgerRecord(1), key: 'wrong-key' }] },
    ];

    for (const [index, value] of malformedFiles.entries()) {
      const caseDir = path.join(workspaceDir, `malformed-${index}`);
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'command-ledger.json'),
        JSON.stringify(value),
        'utf8',
      );
      await expect(new CommandLedger(caseDir).listPendingInputRecoveries()).rejects.toThrow(
        /Invalid command ledger/,
      );
    }
  });

  it('fails closed on duplicate persisted keys or request identities', async () => {
    const duplicateKey = makeLedgerRecord(1);
    const duplicateIdentity = {
      ...makeLedgerRecord(2),
      key: 'fork-run:chat-1:req-1',
      commandType: 'fork-run',
      clientRequestId: 'req-1',
    };
    const cases = [
      [duplicateKey, { ...duplicateKey }],
      [duplicateKey, duplicateIdentity],
    ];

    for (const [index, records] of cases.entries()) {
      const caseDir = path.join(workspaceDir, `duplicate-${index}`);
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, 'command-ledger.json'),
        JSON.stringify({ version: 1, records }),
        'utf8',
      );
      await expect(new CommandLedger(caseDir).listPendingInputRecoveries()).rejects.toThrow(
        /Duplicate command ledger/,
      );
    }
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

  it('serializes concurrent accepts for different keys on disk', async () => {
    const ledger = new CommandLedger(workspaceDir);

    await Promise.all(
      Array.from({ length: 24 }, (_, index) => ledger.accept({
        commandType: 'agent-run',
        chatId: 'chat-1',
        clientRequestId: `req-${index}`,
        payload: { command: `cmd-${index}` },
      })),
    );

    const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
    const persisted = JSON.parse(raw);
    expect(persisted.records).toHaveLength(24);
    expect(persisted.records.map((record) => record.clientRequestId).sort()).toEqual(
      Array.from({ length: 24 }, (_, index) => `req-${index}`).sort(),
    );
  });

  it('serializes terminal state with pending-input settlement', async () => {
    const ledger = new CommandLedger(workspaceDir);
    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-race',
      payload: { command: 'race' },
    });
    await ledger.update(accepted.record.key, {
      status: 'scheduled',
      pendingInputRecovery: 'required',
    });

    await Promise.all([
      ledger.settleTerminal(accepted.record.key, 'failed', { error: 'interrupted' }),
      ledger.settlePendingInputRecovery('chat-1', 'req-race'),
    ]);

    expect(await ledger.listPendingInputRecoveries()).toEqual([]);
    const persisted = JSON.parse(await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8'));
    expect(persisted.records).toEqual([
      expect.objectContaining({ status: 'failed', pendingInputRecovery: 'settled' }),
    ]);
  });

  it('does not retain a command in memory after its durable write fails', async () => {
    const ledger = new CommandLedger(workspaceDir);
    await ledger.accept({
      commandType: 'agent-stop',
      chatId: 'chat-1',
      clientRequestId: 'req-seed',
      payload: { chatId: 'chat-1' },
    });
    const ledgerPath = path.join(workspaceDir, 'command-ledger.json');
    const beforeFailure = await fs.readFile(ledgerPath, 'utf8');
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.writeFile(workspaceDir, 'not a directory', 'utf8');
    const retryInput = {
      commandType: 'agent-stop',
      chatId: 'chat-1',
      clientRequestId: 'req-retry',
      payload: { chatId: 'chat-1' },
    };

    await expect(ledger.accept(retryInput)).rejects.toThrow();
    await fs.rm(workspaceDir, { force: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(ledgerPath, beforeFailure, 'utf8');

    await expect(ledger.accept(retryInput)).resolves.toMatchObject({ kind: 'accepted' });
    const persisted = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    expect(persisted.records.map((record) => record.clientRequestId)).toEqual([
      'req-seed',
      'req-retry',
    ]);
  });

  it('trims loaded records in memory before duplicate detection', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'command-ledger.json'),
      JSON.stringify({
        version: 1,
        records: Array.from({ length: 1005 }, (_, index) => makeLedgerRecord(index)),
      }),
      'utf8',
    );

    const ledger = new CommandLedger(workspaceDir);
    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-0',
      payload: { command: 'cmd-0' },
    });

    expect(accepted.kind).toBe('accepted');

    const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
    const persisted = JSON.parse(raw);
    expect(persisted.records).toHaveLength(1000);
    expect(persisted.records.at(-1).clientRequestId).toBe('req-0');
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

  it('makes the first terminal result durable and immutable', async () => {
    const ledger = new CommandLedger(workspaceDir);
    const accepted = await ledger.accept({
      commandType: 'agent-run',
      chatId: 'chat-1',
      clientRequestId: 'req-terminal',
      payload: { command: 'run' },
    });

    const applied = await ledger.settleTerminal(accepted.record.key, 'finished');
    const duplicate = await ledger.settleTerminal(accepted.record.key, 'finished');
    const conflict = await ledger.settleTerminal(accepted.record.key, 'failed', {
      error: 'late failure',
    });

    expect(applied).toMatchObject({ kind: 'applied', record: { status: 'finished' } });
    expect(duplicate).toMatchObject({ kind: 'duplicate', record: { status: 'finished' } });
    expect(conflict).toMatchObject({ kind: 'conflict', record: { status: 'finished' } });
  });
});
