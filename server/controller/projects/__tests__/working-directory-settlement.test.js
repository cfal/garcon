import { describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkingDirectorySettler } from '../working-directory-settlement.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { ChatRegistry } from '../../chats/store.js';
import { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../../chat-execution/chat-execution-control-repository.js';

function fixture() {
  const chat = { agentId: 'literal-test', executorId: 'local', agentOwnershipEpoch: 2, projectPath: '/project' };
  const registry = {
    getChat: () => chat,
    updateObservedProjectPath: mock(async (_id, input) => {
      chat.projectPath = input.projectPath;
      return { entry: chat, durability: 'durable', changed: true };
    }),
  };
  const inspect = mock(async path => ({ kind: 'available', effectiveProjectKey: path }));
  const ledger = { existingCurrentView: () => ({ viewId: 'view-1' }), appendNotice: mock() };
  const settler = new WorkingDirectorySettler({ registry, inspect, lock: new KeyedPromiseLock(),
    ledger });
  const turn = { turnId: 'command-1', agentOwnershipEpoch: 2, workingDirectory: { kind: 'reported', path: '/project/next' },
    executionSnapshot: { agentId: 'literal-test', executorId: 'local', projectPath: '/project', transcriptViewId: 'view-1', producerLease: { closed: false } } };
  return { chat, registry, inspect, ledger, settler, turn };
}

describe('completion working directory settlement', () => {
  it('persists the executor-validated path once without normalizing its bytes', async () => {
    const f = fixture();
    f.turn.workingDirectory.path = '/project/ next\n';
    expect(await f.settler.settle('chat-1', f.turn, () => true)).toEqual({ kind: 'settled' });
    expect(f.inspect.mock.calls[0].slice(0, 2)).toEqual(['/project/ next\n', 'local']);
    expect(f.registry.updateObservedProjectPath).toHaveBeenCalledWith('chat-1', expect.objectContaining({ projectPath: '/project/ next\n' }));
    expect(f.ledger.appendNotice).not.toHaveBeenCalled();
  });

  it('avoids writes for unchanged, missing, and stale observations', async () => {
    const f = fixture();
    f.turn.workingDirectory.path = '/project';
    await f.settler.settle('chat-1', f.turn, () => true);
    await f.settler.settle('chat-1', { ...f.turn, workingDirectory: { kind: 'unavailable', reason: 'exit' } }, () => true);
    f.chat.agentOwnershipEpoch++;
    await f.settler.settle('chat-1', f.turn, () => true);
    expect(f.registry.updateObservedProjectPath).not.toHaveBeenCalled();
    expect(f.ledger.appendNotice).not.toHaveBeenCalled();
    expect(f.inspect).toHaveBeenCalledTimes(1);
  });

  it.each(['ownership', 'path', 'attempt', 'lease'])('fences %s changes during inspection', async change => {
    const f = fixture();
    let current = true;
    f.inspect.mockImplementation(async () => {
      if (change === 'ownership') f.chat.agentOwnershipEpoch++;
      if (change === 'path') f.chat.projectPath = '/replacement';
      if (change === 'attempt') current = false;
      if (change === 'lease') f.turn.executionSnapshot.producerLease.closed = true;
      return { kind: 'available', effectiveProjectKey: '/project/next' };
    });
    expect(await f.settler.settle('chat-1', f.turn, () => current)).toEqual({ kind: 'settled' });
    expect(f.registry.updateObservedProjectPath).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'write-failed', 'write-unknown'])('returns typed %s failure without changing the confirmed path', async reason => {
    const f = fixture();
    if (reason === 'unavailable') f.inspect.mockImplementation(async () => ({ kind: 'unavailable', reason: 'outside-base' }));
    else if (reason === 'write-unknown') f.registry.updateObservedProjectPath.mockResolvedValue({ durability: 'unknown' });
    else f.registry.updateObservedProjectPath.mockImplementation(async () => { throw new Error('Disk failed'); });
    const result = await f.settler.settle('chat-1', f.turn, () => true);
    expect(result).toMatchObject({ kind: 'failed' });
    expect(f.ledger.appendNotice.mock.calls).toEqual([['chat-1', 'view-1', {
      title: 'Working directory not saved', content: result.message,
    }]]);
    expect(f.chat.projectPath).toBe('/project');
  });

  it('retains the failure when an uncertain write has published its candidate path', async () => {
    const f = fixture();
    f.registry.updateObservedProjectPath.mockImplementation(async (_id, input) => {
      f.chat.projectPath = input.projectPath;
      return { durability: 'unknown' };
    });
    expect(await f.settler.settle('chat-1', f.turn, () => true)).toMatchObject({ kind: 'failed' });
    expect(f.ledger.appendNotice).toHaveBeenCalledTimes(1);
  });

  it.each(['ownership', 'view', 'attempt', 'lease'])('does not publish a failure into a replaced %s after a write', async change => {
    const f = fixture();
    let current = true;
    f.registry.updateObservedProjectPath.mockImplementation(async () => {
      if (change === 'ownership') f.chat.agentOwnershipEpoch++;
      if (change === 'view') f.ledger.existingCurrentView = () => ({ viewId: 'view-2' });
      if (change === 'attempt') current = false;
      if (change === 'lease') f.turn.executionSnapshot.producerLease.closed = true;
      return { durability: 'unknown' };
    });
    await f.settler.settle('chat-1', f.turn, () => current);
    expect(f.ledger.appendNotice).not.toHaveBeenCalled();
  });

  it('pauses queued work when a cwd write fails alongside a read receipt', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'cwd-settlement-'));
    const id = '1783725900000200';
    const registry = new ChatRegistry(directory, { saveDelayMs: 60_000 });
    let execution;
    let rename;
    const release = Promise.withResolvers();
    try {
      await registry.init();
      registry.addChat({ id, agentId: 'literal-test', model: 'test', projectPath: '/project',
        agentOwnershipEpoch: 'epoch-1', agentSettingsById: {}, parentChat: null });
      await registry.flush();
      const dispatched = mock(async () => {});
      const turn = { ...fixture().turn, agentOwnershipEpoch: 'epoch-1' };
      const settler = new WorkingDirectorySettler({ registry, lock: new KeyedPromiseLock(),
        ledger: { existingCurrentView: () => ({ viewId: 'view-1' }), appendNotice: mock() },
        inspect: async path => ({ kind: 'available', effectiveProjectKey: path }),
      });
      execution = new ChatExecutionCoordinator({ isChatRunning: () => false, runAgentTurn: dispatched },
        { admitInput: async () => ({ inserted: true }), hasMatchingInput: () => false,
          admitQueuedInput: () => ({ inserted: true }), discardPreparedInput() {} },
        () => ({}), () => true, new InMemoryChatExecutionControlRepository('synthetic-server'), {
          projectAdmission: { assertAvailable: async () => {} }, attachmentAdmission: { assertSupported() {} },
          isControlInputViewCurrent: () => true, executionPolicy: () => 'literal', workingDirectorySettlement: settler,
        });
      const reservation = execution.reserveDirectTurn(id, { turnId: turn.turnId });
      await execution.runReservedTurn(reservation, 'cd next', { turnId: turn.turnId });
      await execution.createChatQueueEntry(id, 'printf follow-up');
      execution.markRunTerminalCommitted(id, turn.turnId);
      const entered = Promise.withResolvers();
      const originalRename = fs.rename;
      rename = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
        if (target !== join(directory, 'chats.json')) return originalRename(source, target);
        entered.resolve();
        await release.promise;
        throw new Error('Synthetic disk failure');
      });
      const settling = execution.onAgentTurnTerminal(id, turn, 'finished');
      await entered.promise;
      expect(registry.getChat(id).projectPath).toBe('/project');
      registry.updateChat(id, { lastReadAt: '2026-01-01T00:00:00.000Z' });
      release.resolve();
      expect(await settling).toMatchObject({ kind: 'failed' });
      await execution.checkChatIdle(id);
      expect((await execution.readChatExecutionControl(id)).pause).not.toBeNull();
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(registry.getChat(id)).toMatchObject({ projectPath: '/project', lastReadAt: '2026-01-01T00:00:00.000Z' });
      const stored = JSON.parse(await fs.readFile(join(directory, 'chats.json'), 'utf8'));
      expect(stored.sessions[id].projectPath).toBe('/project');
    } finally {
      release.resolve();
      rename?.mockRestore();
      execution?.beginShutdown();
      await registry.flush();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
