import { NodeSupervisor } from '../supervisor.js';

let first = true;
const supervisor = new NodeSupervisor({
  clock: { read: () => ({ elapsedMs: 0, discontinuity: false }) },
  async cleanup() {
    if (!first) return;
    first = false;
    void supervisor[process.argv[2]](connection);
  },
});
const connection = supervisor.attach(supervisor.openSession('synthetic-controller'));
const cleaned = await supervisor.revoke();
await new Promise(setImmediate);
console.log(JSON.stringify({ cleaned, status: supervisor.status, failure: supervisor.cleanupFailure }));
await supervisor.retryCleanup();
