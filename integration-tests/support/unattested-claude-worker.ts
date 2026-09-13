import { createNodeInstanceRuntime } from '../../server/execution-node/worker/instance-runtime.js';
import { runNodeWorkerRuntime } from '../../server/execution-node/worker/main.js';
import { createNodeSessionRuntime } from '../../server/execution-node/worker/session-runtime.js';
import { UNATTESTED_CLAUDE_WORKER_MS, unattestedClaudeWorkerCommand } from './unattested-claude-command.js';
import { unattestedClaudeExecution } from './unattested-claude-execution.js';

const role = process.argv[2];
if (process.argv.length !== 3 || (role !== 'session' && role !== 'instance')) process.exit(2);
setTimeout(() => process.exit(1), UNATTESTED_CLAUDE_WORKER_MS).unref();

await runNodeWorkerRuntime(role, async (context, writer) => {
  if (role === 'session') return createNodeSessionRuntime(context, writer, () => unattestedClaudeWorkerCommand('instance'));
  return createNodeInstanceRuntime(context, writer, (instance) => {
    if (instance.agentId !== 'claude') throw new Error('Unattested characterization requires Claude');
    return {
      // Only table record count is bounded; these fixtures make no native capacity or successor-safety claim.
      occupancy: { reserveExecution() { return { enter() {}, release() {} }; }, close() {} },
      limits: { maxOperations: instance.maxOperations, nativeSettlementMs: UNATTESTED_CLAUDE_WORKER_MS + 30_000 },
      bind: unattestedClaudeExecution,
    };
  });
});
