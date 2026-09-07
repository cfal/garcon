import { acquireWebBuildLock } from '../../web-build-coordinator.js';

const lockPath = process.argv[2];
if (!lockPath) throw new Error('Lock path is required');

const release = await acquireWebBuildLock({
  lockPath,
  retries: 0,
});
process.stdout.write('ready\n');
await Bun.stdin.text();
await release();
