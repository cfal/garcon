import { GitRuntime } from '../../../../server/runtime/git/runtime.js';

if (Bun.version !== '1.4.3') throw new Error('The Git runtime oracle requires Bun 1.4.3');

const { projectPath, action } = JSON.parse(await Bun.stdin.text()) as {
  projectPath: string;
  action: 'mutations' | 'review';
};
const scope = { executorId: 'local', instanceId: 'serving-test' };
const runtime = new GitRuntime({ ...scope, projectBasePath: projectPath, assertAvailable() {} });
try {
  if (action === 'mutations') {
    const commit = await runtime.git.commit({ projectPath, message: 'test truncated output', files: ['a.txt'] });
    const stage = await runtime.git.stagePaths({ projectPath, paths: ['a.txt'], mode: 'stage' });
    console.log(JSON.stringify([commit, stage]));
  } else {
    const snapshot = await runtime.git.getCommitSnapshot({ projectPath, commit: 'HEAD' });
    if (snapshot.status !== 'ready') throw new Error('expected a commit snapshot');
    const response = await runtime.git.getReviewDocumentFileBodies({
      projectPath, document: { ...scope, documentId: snapshot.documentId },
      files: ['a.txt'], purpose: 'visible',
    });
    if (response.status !== 'ready' || response.documentId !== snapshot.documentId || !response.diagnostics) {
      throw new Error('expected ready review bodies and their diagnostics');
    }
    response.documentId = '<document>';
    for (const phase of response.diagnostics.phases) phase.durationMs = 0;
    for (const command of response.diagnostics.commands) command.durationMs = 0;
    console.log(JSON.stringify(response));
  }
} finally {
  runtime.dispose();
}
