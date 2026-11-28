import type { ExecutionGitRequests } from '../../../../common/git-execution.js';
import { GitRuntime } from '../../../../server/runtime/git/runtime.js';

if (Bun.version !== '1.4.3') throw new Error('The Git runtime oracle requires the pinned Bun 1.4.3');

type Method = 'getQuickSummary' | 'getWorkingTreeFingerprint' | 'getFileHistory' | 'getBlame' | 'getGraph'
  | 'getWorktrees' | 'getTargetCandidates' | 'getRepoInfo' | 'getHistoryCommits' | 'getCommitSnapshot';
type Read = {
  [K in Method]: {
    method: K;
    request: ExecutionGitRequests[K];
  };
}[Method];

const { base, reads } = JSON.parse(await Bun.stdin.text()) as { base: string; reads: Read[] };
const runtime = new GitRuntime({
  projectBasePath: base,
  executorId: 'local',
  instanceId: 'git-oracle-instance',
  assertAvailable() {},
});
try {
  const results = [];
  for (const read of reads) {
    switch (read.method) {
      case 'getQuickSummary': results.push(await runtime.git.getQuickSummary(read.request)); break;
      case 'getWorkingTreeFingerprint': results.push(await runtime.git.getWorkingTreeFingerprint(read.request)); break;
      case 'getFileHistory': results.push(await runtime.git.getFileHistory(read.request)); break;
      case 'getBlame': results.push(await runtime.git.getBlame(read.request)); break;
      case 'getGraph': results.push(await runtime.git.getGraph(read.request)); break;
      case 'getWorktrees': results.push(await runtime.git.getWorktrees(read.request)); break;
      case 'getTargetCandidates': results.push(await runtime.git.getTargetCandidates(read.request)); break;
      case 'getRepoInfo': results.push(await runtime.git.getRepoInfo(read.request)); break;
      case 'getHistoryCommits': results.push(await runtime.git.getHistoryCommits(read.request)); break;
      case 'getCommitSnapshot': results.push(await runtime.git.getCommitSnapshot(read.request)); break;
    }
  }
  console.log(JSON.stringify(results));
} finally {
  runtime.dispose();
}
