import type { ExecutionGitRequests } from '../../../../common/git-execution.js';
import { GitRuntime } from '../../../../server/runtime/git/runtime.js';

if (Bun.version !== '1.4.3') throw new Error('The Git mutation oracle requires the pinned Bun 1.4.3');

type Method = 'getStashes' | 'applyStash' | 'popStash' | 'dropStash' | 'discard'
  | 'getConflicts' | 'getConflictDetails' | 'markConflictResolved' | 'acceptConflictSide';
type Operation = {
  [K in Method]: { method: K; request: ExecutionGitRequests[K] };
}[Method];

const { base, operations } = JSON.parse(await Bun.stdin.text()) as { base: string; operations: Operation[] };
const runtime = new GitRuntime({
  projectBasePath: base,
  executorId: 'local',
  instanceId: 'git-mutation-oracle',
  assertAvailable() {},
});
try {
  const results = [];
  for (const operation of operations) {
    try {
      switch (operation.method) {
        case 'getStashes': results.push({ ok: await runtime.git.getStashes(operation.request) }); break;
        case 'applyStash': results.push({ ok: await runtime.git.applyStash(operation.request) }); break;
        case 'popStash': results.push({ ok: await runtime.git.popStash(operation.request) }); break;
        case 'dropStash': results.push({ ok: await runtime.git.dropStash(operation.request) }); break;
        case 'discard': results.push({ ok: await runtime.git.discard(operation.request) }); break;
        case 'getConflicts': results.push({ ok: await runtime.git.getConflicts(operation.request) }); break;
        case 'getConflictDetails': results.push({ ok: await runtime.git.getConflictDetails(operation.request) }); break;
        case 'markConflictResolved': results.push({ ok: await runtime.git.markConflictResolved(operation.request) }); break;
        case 'acceptConflictSide': results.push({ ok: await runtime.git.acceptConflictSide(operation.request) }); break;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      results.push({ error: { code: 'code' in error ? error.code : null, message: error.message } });
    }
  }
  console.log(JSON.stringify(results));
} finally {
  runtime.dispose();
}
