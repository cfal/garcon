import { mock } from 'bun:test';
import { LocalWorkspaceFileService } from '../../server/execution-node/local-workspace-files.js';
import { getFileLockKey } from '../../server/files/file-revision.js';

const gateUrl = process.env.GARCON_TEST_FILE_SAVE_GATE;
const filePath = process.env.GARCON_TEST_FILE_SAVE_PATH;
if (!gateUrl || !filePath) throw new Error('Workspace file fixture requires its path and barrier');
const lockKey = await getFileLockKey(filePath);

async function reachGate(stage: string, index: number, detail: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch(new URL(stage, gateUrl), {
    method: 'POST', body: JSON.stringify({ index, ...detail }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Synthetic file-save barrier failed');
}

class GatedWorkspaceFileService extends LocalWorkspaceFileService {
  constructor(options: ConstructorParameters<typeof LocalWorkspaceFileService>[0]) {
    let requests = 0;
    super({
      ...options,
      saveLocks: {
        async runExclusive<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
          if (key !== lockKey) return options.saveLocks.runExclusive(key, work, signal);
          const index = ++requests;
          const operation = options.saveLocks.runExclusive(key, async () => {
            await reachGate(index === 1 ? 'held' : 'executing', index);
            return work();
          }, signal);
          const outcome = operation.then(
            (value) => ({ kind: 'completed' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          );
          if (index === 2) await reachGate('queued', index, { hasSignal: signal !== undefined });
          const settled = await outcome;
          await reachGate('settled', index, { kind: settled.kind, aborted: signal?.aborted === true });
          if (settled.kind === 'rejected') throw settled.error;
          return settled.value;
        },
      },
    });
  }
}

mock.module('../../server/execution-node/local-workspace-files.js', () => ({
  LocalWorkspaceFileService: GatedWorkspaceFileService,
}));
