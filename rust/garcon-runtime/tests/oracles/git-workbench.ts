import { createGitOperations } from '../../../../server/runtime/git/git-service.js';
import type { GitWorkbenchSnapshotOptions } from '../../../../server/runtime/git/types.js';

if (Bun.version !== '1.4.3') throw new Error('The workbench oracle requires Bun 1.4.3');

type Stage = {
  projectPath: string;
  file: string;
  mode: 'stage' | 'unstage';
  contextLines: number;
  reviewMode?: 'working' | 'staged';
  reviewContext?: number;
  bodyFingerprint?: string;
  patchDigest?: string;
  expectError?: boolean;
} & ({ hunkIndex: number } | { selection: { lineIndices: number[] } });

type Input = { snapshots: GitWorkbenchSnapshotOptions[] } | { stage: Stage[] };
const input = JSON.parse(await Bun.stdin.text()) as Input;
const git = createGitOperations();
const output = [];
if ('snapshots' in input) {
  for (const options of input.snapshots) {
    const snapshot = await git.getWorkbenchSnapshot(options);
    if (snapshot.status === 'ready') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshot.snapshotId)
          || snapshot.snapshotId !== snapshot.reviewSummary.documentId) {
        throw new Error('workbench returned an invalid document ID');
      }
      snapshot.snapshotId = '<document>';
      snapshot.reviewSummary.documentId = '<document>';
    }
    output.push(snapshot);
  }
} else {
  for (const step of input.stage) {
    const { reviewMode, reviewContext, bodyFingerprint, patchDigest, expectError, ...operation } = step;
    const snapshot = await git.getWorkbenchSnapshot({
      projectPath: step.projectPath,
      mode: reviewMode ?? (step.mode === 'stage' ? 'working' : 'staged'),
      context: reviewContext ?? step.contextLines,
      selectedFile: step.file,
    });
    if (snapshot.status !== 'ready') throw new Error('expected a workbench snapshot');
    const documentId = snapshot.reviewSummary.documentId;
    const response = await git.getReviewDocumentFileBodies({
      projectPath: step.projectPath, documentId, files: [step.file], purpose: 'visible',
    });
    if (response.status !== 'ready') throw new Error('expected a review body');
    const body = response.files[step.file];
    if (!body?.patchDigest) throw new Error('expected a patch digest');
    const request = {
      ...operation, documentId, bodyFingerprint: bodyFingerprint ?? body.bodyFingerprint,
      patchDigest: patchDigest ?? body.patchDigest,
    };
    try {
      const result = 'hunkIndex' in request ? await git.stageHunk(request) : await git.stageSelection(request);
      if (expectError) throw new Error('stage operation unexpectedly succeeded');
      output.push(result);
    } catch (error) {
      if (!expectError || !(error instanceof Error) || !('code' in error)) throw error;
      output.push({ code: error.code, message: error.message });
    }
  }
}
console.log(JSON.stringify(output));
