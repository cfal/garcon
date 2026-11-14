import { TaskWorker } from '../lib/task-worker.js';
import type { LedgerActivityResults, LedgerActivityTask } from './activity-tasks.js';

export class LedgerActivityWorker {
  readonly #reads = new Set<{ readonly databasePath: string; readonly abort: AbortController }>();
  readonly #worker = new TaskWorker<LedgerActivityTask, LedgerActivityResults>({
    worker: 'ledger-activity',
    sourceUrl: new URL('./activity-worker-main.ts', import.meta.url),
    label: 'Ledger activity',
  });

  async read(task: LedgerActivityTask): Promise<LedgerActivityResults['read-run-outcome']> {
    const read = { databasePath: task.databasePath, abort: new AbortController() };
    this.#reads.add(read);
    try {
      return await this.#worker.run(task, [], read.abort.signal);
    } finally {
      this.#reads.delete(read);
    }
  }

  retire(databasePath: string): void {
    for (const read of this.#reads) {
      if (read.databasePath === databasePath) read.abort.abort(new Error('Ledger activity read was retired'));
    }
  }

  close(): void {
    this.#worker.close();
  }
}
