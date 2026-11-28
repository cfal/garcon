import { GitRuntime } from '../../../../server/runtime/git/runtime.js';
import type { GhRequests } from '../../../../common/gh.js';
import { GitServiceError } from '../../../../common/git-error.js';

if (Bun.version !== '1.4.3') throw new Error('The GitHub CLI oracle requires Bun 1.4.3');
type Call = { [Method in GhMethod]: [Method, GhRequests[Method]] }[GhMethod];
type GhMethod = keyof GhRequests;
const { root, calls } = JSON.parse(await Bun.stdin.text()) as { root: string; calls: Call[] };
const runtime = new GitRuntime({ executorId: 'local', instanceId: 'synthetic', projectBasePath: root, assertAvailable() {} });
const results = [];
try {
  for (const call of calls) {
    try {
      switch (call[0]) {
        case 'getStatus': results.push(await runtime.gh.getStatus()); break;
        case 'listPullRequests': results.push(await runtime.gh.listPullRequests(call[1])); break;
        case 'getPullRequest': results.push(await runtime.gh.getPullRequest(call[1])); break;
        case 'getPullRequestReviewTarget': results.push(await runtime.gh.getPullRequestReviewTarget(call[1])); break;
        case 'createPullRequestComment': results.push(await runtime.gh.createPullRequestComment(call[1])); break;
        case 'minimizePullRequestComment': results.push(await runtime.gh.minimizePullRequestComment(call[1])); break;
      }
    } catch (error) {
      if (!(error instanceof GitServiceError)) throw error;
      results.push({ code: error.code, message: error.message, status: error.status });
    }
  }
  Bun.stdout.write(JSON.stringify(results));
} finally {
  runtime.dispose();
}
