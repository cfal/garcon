import { describe, expect, it, mock } from 'bun:test';
import { WorkingDirectorySettler } from '../working-directory-settlement.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';

function fixture() {
  const chat = { agentId: 'literal-test', executorId: 'local', agentOwnershipEpoch: 2, projectPath: '/project' };
  const registry = {
    getChat: () => chat,
    updateProjectPath: mock(async (_id, input) => { chat.projectPath = input.projectPath; }),
  };
  const inspect = mock(async path => ({ kind: 'available', effectiveProjectKey: path }));
  const settler = new WorkingDirectorySettler({ registry, inspect, lock: new KeyedPromiseLock(),
    ledger: { existingCurrentView: () => ({ viewId: 'view-1' }) } });
  const turn = { turnId: 'command-1', agentOwnershipEpoch: 2, workingDirectory: { kind: 'reported', path: '/project/next' },
    executionSnapshot: { agentId: 'literal-test', executorId: 'local', projectPath: '/project', transcriptViewId: 'view-1', producerLease: { closed: false } } };
  return { chat, registry, inspect, settler, turn };
}

describe('completion working directory settlement', () => {
  it('persists the executor-validated path once without normalizing its bytes', async () => {
    const f = fixture();
    f.turn.workingDirectory.path = '/project/ next\n';
    expect(await f.settler.settle('chat-1', f.turn, () => true)).toEqual({ kind: 'settled' });
    expect(f.inspect.mock.calls[0].slice(0, 2)).toEqual(['/project/ next\n', 'local']);
    expect(f.registry.updateProjectPath).toHaveBeenCalledWith('chat-1', expect.objectContaining({ projectPath: '/project/ next\n' }), { flush: true });
  });

  it('avoids writes for unchanged, missing, and stale observations', async () => {
    const f = fixture();
    f.turn.workingDirectory.path = '/project';
    await f.settler.settle('chat-1', f.turn, () => true);
    await f.settler.settle('chat-1', { ...f.turn, workingDirectory: { kind: 'unavailable', reason: 'exit' } }, () => true);
    f.chat.agentOwnershipEpoch++;
    await f.settler.settle('chat-1', f.turn, () => true);
    expect(f.registry.updateProjectPath).not.toHaveBeenCalled();
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
    expect(f.registry.updateProjectPath).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'write-failed'])('returns typed %s failure without changing the confirmed path', async reason => {
    const f = fixture();
    if (reason === 'unavailable') f.inspect.mockImplementation(async () => ({ kind: 'unavailable', reason: 'outside-project-base' }));
    else f.registry.updateProjectPath.mockImplementation(async () => { throw new Error('Disk failed'); });
    expect(await f.settler.settle('chat-1', f.turn, () => true)).toMatchObject({ kind: 'failed' });
    expect(f.chat.projectPath).toBe('/project');
  });
});
