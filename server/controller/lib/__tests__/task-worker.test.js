import { describe, expect, it } from 'bun:test';
import { TaskWorker } from '../task-worker.js';

function createWorker() {
  return new TaskWorker({
    worker: 'token-fitting',
    sourceUrl: new URL('./fixtures/task-worker.js', import.meta.url),
    label: 'Synthetic task',
  });
}

describe('TaskWorker recovery', () => {
  it.each([
    ['crash', 'worker failed:'],
    ['exit', 'worker exited'],
    ['malformed', 'worker sent an invalid event'],
    ['wrong-task', 'worker sent an invalid event'],
  ])('rejects the active %s task and serves queued work with a fresh worker', async (kind, message) => {
    const worker = createWorker();
    try {
      const failed = worker.run({ kind }, [], undefined).catch((error) => error);
      const queued = worker.run({ kind: 'echo' }, ['synthetic content'], undefined);

      const [failure, result] = await Promise.all([failed, queued]);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toStartWith(`Synthetic task ${message}`);
      if (kind === 'crash') expect(failure.message).toContain('synthetic worker failure');
      expect(result).toEqual(['synthetic content']);
      expect(await worker.run({ kind: 'echo' }, [], undefined)).toEqual([]);
    } finally {
      worker.close();
    }
  });

  it('preserves a task error code and continues serving work', async () => {
    const worker = createWorker();
    try {
      await expect(worker.run({ kind: 'task-error' }, [], undefined)).rejects.toMatchObject({
        message: 'synthetic task failure', code: 'SYNTHETIC',
      });
      expect(await worker.run({ kind: 'echo' }, ['next'], undefined)).toEqual(['next']);
    } finally {
      worker.close();
    }
  });
});
