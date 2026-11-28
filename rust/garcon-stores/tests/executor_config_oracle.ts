import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutorConfigStore } from '../../../server/controller/executors/config-store.ts';

const [mode, workspace] = Bun.argv.slice(2);
const store = new ExecutorConfigStore(workspace);
await store.initialize();
if (mode === 'seed') {
  await store.create({ direction: 'executor-connects', label: 'Bun seed', allowExecutorManagement: true,
    advertisedUrl: 'wss://fixture.invalid/executor/{executorId}?tag=a&tag=b' });
  const reloaded = new ExecutorConfigStore(workspace);
  await reloaded.initialize();
  console.log(JSON.stringify(reloaded.list()[0]));
} else if (mode === 'check-bytes-and-update') {
  const path = join(workspace, 'executors.json');
  const before = await readFile(path, 'utf8');
  const id = store.list()[0].id;
  await store.update(id, { allowControllerCli: true });
  const preservedBytes = before === await readFile(path, 'utf8');
  const mutated = await store.update(id, { label: 'Bun renamed', allowExecutorManagement: false });
  console.log(JSON.stringify({ preservedBytes, mutated }));
} else {
  throw new Error(`Unknown executor-config oracle mode: ${mode}`);
}
