import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRegistry } from '../../server/controller/agents/registry.js';
import { LedgerActivityWorker } from '../../server/controller/ledger/activity-worker.js';

const root = process.env.GARCON_TEST_ACTIVITY_FAULT_ROOT;
if (!root) throw new Error('Activity fault directory is required');
const release = join(root, 'activity-launch-release');
const run = AgentRegistry.prototype.runAgentTurn;
AgentRegistry.prototype.runAgentTurn = async function (...args) {
  await run.apply(this, args);
  if (args[1] !== 'Synthetic delayed activity launch') return;
  const deadline = Date.now() + 20_000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('Activity launch barrier timed out');
    await Bun.sleep(10);
  }
  throw new Error('Synthetic late activity launch rejection');
};

const busy = join(root, 'activity-worker-busy');
const observed = join(root, 'activity-worker-busy-observed');
const hold = join(root, 'activity-worker-hold');
const releaseRead = join(root, 'activity-worker-release');
const read = LedgerActivityWorker.prototype.read;
LedgerActivityWorker.prototype.read = async function (task) {
  if (existsSync(busy)) {
    writeFileSync(observed, 'observed');
    throw Object.assign(new Error('Synthetic secondary reader contention'), { code: 'SQLITE_BUSY' });
  }
  if (existsSync(hold)) {
    const outcome = await read.call(this, task);
    writeFileSync(join(root, 'activity-worker-held'), 'held');
    const deadline = Date.now() + 20_000;
    while (!existsSync(releaseRead)) {
      if (Date.now() > deadline) throw new Error('Activity read barrier timed out');
      await Bun.sleep(10);
    }
    writeFileSync(join(root, 'activity-worker-released'), 'released');
    return outcome;
  }
  return read.call(this, task);
};
