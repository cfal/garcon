import { acquireWorkspaceLease } from '../../workspace-lease.js';

const workspaceDir = process.argv[2];
if (!workspaceDir) throw new Error('Workspace path is required');

await acquireWorkspaceLease(workspaceDir, {
  staleMs: 2_000,
  updateMs: 1_000,
  retries: 0,
});
process.stdout.write('ready\n');
await new Promise(() => undefined);
