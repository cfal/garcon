import { serveTaskWorker } from '../lib/task-worker-host.js';
import { readLedgerRunOutcome } from './activity-query.js';
import type { LedgerActivityTask } from './activity-tasks.js';

serveTaskWorker<LedgerActivityTask>('Ledger activity', ['read-run-outcome'], (task, items) => {
  if (items.length !== 0) throw new TypeError('Ledger activity received unexpected items');
  return readLedgerRunOutcome(task);
});
