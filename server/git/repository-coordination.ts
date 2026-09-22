import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { probeWorktreeLayout } from './worktree-layout.js';
import { settleGitProcesses } from './operation-context.js';

const mutations = new KeyedPromiseLock();
const heldRepository = new AsyncLocalStorage<string>();

export async function withRepositoryMutation<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
  const layout = await probeWorktreeLayout(projectPath);
  const key = await realpath(layout?.commonDir ?? projectPath);
  if (heldRepository.getStore() === key) return operation();
  return mutations.runExclusive(key, () => heldRepository.run(key, async () => {
    try { return await operation(); }
    finally { await settleGitProcesses(); }
  }));
}
