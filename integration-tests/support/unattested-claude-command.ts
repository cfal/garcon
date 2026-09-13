import { fileURLToPath } from 'node:url';
import type { NodeWorkerRole } from '../../server/execution-node/worker/roles.js';

export const UNATTESTED_CLAUDE_WORKER_MS = 90_000;

export function unattestedClaudeWorkerCommand(role: NodeWorkerRole): [string, ...string[]] {
  return [process.execPath, '--no-env-file', '--config=/dev/null',
    fileURLToPath(new URL('./unattested-claude-worker.ts', import.meta.url)), role];
}
