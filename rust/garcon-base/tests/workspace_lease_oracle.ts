import { acquireWorkspaceLease, WorkspaceInUseError } from '../../../server/common/workspace-lease.ts';

const [operation, directory] = process.argv.slice(2);
if (!directory) throw new Error('Expected a workspace directory');

try {
  const lease = await acquireWorkspaceLease(directory, { retries: 0, staleMs: 2_000, updateMs: 1_000 });
  try {
    console.log('acquired');
    if (operation === 'hold') await process.stdin[Symbol.asyncIterator]().next();
  } finally {
    await lease.release();
  }
} catch (error) {
  if (!(error instanceof WorkspaceInUseError)) throw error;
  console.log(error.code);
}
