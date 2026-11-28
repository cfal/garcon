import {
  GitReviewDocumentRegistry,
  type RegisterGitReviewDocumentInput,
} from '../../../../server/runtime/git/review-document-registry.js';
import { createReviewDocumentOperations } from '../../../../server/runtime/git/review-document-service.js';
import type { GitReviewDocumentFileBodiesOptions } from '../../../../server/runtime/git/types.js';

if (Bun.version !== '1.4.3') throw new Error('The Git review oracle requires the pinned Bun 1.4.3');

const { registration, requests } = JSON.parse(await Bun.stdin.text()) as {
  registration: RegisterGitReviewDocumentInput;
  requests: Pick<GitReviewDocumentFileBodiesOptions, 'files' | 'purpose'>[];
};
const registry = new GitReviewDocumentRegistry();
const { id } = registry.register(registration);
const operations = createReviewDocumentOperations(registry);
const results = [];
const diffs = [];
for (const request of requests) {
  const trace: NonNullable<GitReviewDocumentFileBodiesOptions['trace']> = [];
  const result = await operations.getReviewDocumentFileBodies({
    ...request, projectPath: registration.projectPath, documentId: id, trace,
  });
  if (result.documentId !== id) throw new Error('Got the wrong review document id');
  results.push({ ...result, documentId: '<document>' });
  diffs.push(trace.map(({ args }) => args));
}
console.log(JSON.stringify({ results, diffs }));
