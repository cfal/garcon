import { createGitOperations } from '../../../../server/runtime/git/git-service.js';
import { assertRealWithinBase, ProjectBoundaryError } from '../../../../server/common/path-boundary.js';
import { GitDomainError } from '../../../../server/runtime/git/git-domain-error.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GitComparisonFreshnessOptions, GitComparisonSnapshotOptions,
} from '../../../../server/runtime/git/types.js';

if (Bun.version !== '1.4.3') throw new Error('The Git comparison oracle requires Bun 1.4.3');

const { snapshots = [], freshness = [], allowedRoot, validationEdits } = JSON.parse(await Bun.stdin.text()) as {
  snapshots?: GitComparisonSnapshotOptions[];
  freshness?: GitComparisonFreshnessOptions[];
  allowedRoot?: string;
  validationEdits?: string[];
};
const git = createGitOperations({
  assertProjectPathAllowed: allowedRoot
    ? (project) => assertRealWithinBase(allowedRoot, project)
    : undefined,
});
type Failure = { code: string; message: string };
const results: {
  snapshots: (Awaited<ReturnType<typeof git.getComparisonSnapshot>> | Failure)[];
  freshness: (Awaited<ReturnType<typeof git.getComparisonFreshness>> | Failure)[];
} = { snapshots: [], freshness: [] };

function failure(error: unknown): Failure {
  if (error instanceof GitDomainError) return { code: error.code, message: error.message };
  if (error instanceof ProjectBoundaryError) return { code: error.errorCode, message: error.message };
  throw error;
}
function traceForValidationEdits(projectPath: string): GitComparisonSnapshotOptions['trace'] {
  if (!validationEdits) return undefined;
  const trace: NonNullable<GitComparisonSnapshotOptions['trace']> = [];
  let statusCount = 0;
  trace.push = function (...entries) {
    for (const { args } of entries) {
      if (!args.includes('--porcelain=v1') || ++statusCount % 2 !== 0) continue;
      const edit = validationEdits[statusCount / 2 - 1];
      if (edit !== undefined) writeFileSync(join(projectPath, 'a.txt'), edit);
    }
    return Array.prototype.push.apply(this, entries);
  };
  return trace;
}
for (const request of snapshots) {
  try {
    const snapshot = await git.getComparisonSnapshot({
      ...request, trace: traceForValidationEdits(request.projectPath),
    });
    if (snapshot.status === 'ready') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshot.documentId)) {
        throw new Error('comparison returned an invalid document ID');
      }
      snapshot.documentId = '<document>';
    }
    results.snapshots.push(snapshot);
  } catch (error) {
    results.snapshots.push(failure(error));
  }
}
for (const request of freshness) {
  try {
    results.freshness.push(await git.getComparisonFreshness(request));
  } catch (error) {
    results.freshness.push(failure(error));
  }
}
console.log(JSON.stringify(results));
