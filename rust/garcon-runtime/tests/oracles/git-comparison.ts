import { createGitOperations } from '../../../../server/runtime/git/git-service.js';
import type {
  GitComparisonFreshnessOptions, GitComparisonSnapshotOptions,
} from '../../../../server/runtime/git/types.js';

if (Bun.version !== '1.4.3') throw new Error('The Git comparison oracle requires Bun 1.4.3');

const { snapshots, freshness } = JSON.parse(await Bun.stdin.text()) as {
  snapshots: GitComparisonSnapshotOptions[];
  freshness: GitComparisonFreshnessOptions[];
};
const git = createGitOperations();
const results = { snapshots: [], freshness: [] } as {
  snapshots: Awaited<ReturnType<typeof git.getComparisonSnapshot>>[];
  freshness: Awaited<ReturnType<typeof git.getComparisonFreshness>>[];
};
for (const request of snapshots) {
  const snapshot = await git.getComparisonSnapshot(request);
  if (snapshot.status === 'ready') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshot.documentId)) {
      throw new Error('comparison returned an invalid document ID');
    }
    snapshot.documentId = '<document>';
  }
  results.snapshots.push(snapshot);
}
for (const request of freshness) {
  results.freshness.push(await git.getComparisonFreshness(request));
}
console.log(JSON.stringify(results));
