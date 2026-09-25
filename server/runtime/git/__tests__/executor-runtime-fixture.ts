import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRuntime } from '../runtime.js';
import { runGit } from '../run.js';
import type { GitReviewDocumentRegistry } from '../review-document-registry.js';

const cleanups: Array<() => Promise<unknown>> = [];
export async function cleanupExecutorRuntimeFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function executorRuntimeFixture(reviewRegistry?: GitReviewDocumentRegistry) {
  const temporary = path.join(os.homedir(), 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'git-runtime-'));
  cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
  const projectPath = path.join(root, 'repo');
  await fs.mkdir(projectPath);
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.invalid']);
  await runGit(projectPath, ['config', 'user.name', 'Synthetic Author']);
  await fs.writeFile(path.join(projectPath, 'tracked.txt'), 'initial\n');
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-m', 'initial']);
  const runtime = new GitRuntime({
    executorId: 'local', instanceId: 'test-instance', projectBasePath: root,
    assertAvailable() {}, reviewRegistry,
  });
  cleanups.push(async () => runtime.dispose());
  return { root, projectPath, git: runtime.git };
}

export async function untrackedReview(git: GitRuntime['git'], projectPath: string, file: string) {
  const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 2 });
  if (snapshot.status !== 'ready') throw new Error('Expected repository');
  const document = { executorId: snapshot.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
  const loaded = await git.getReviewDocumentFileBodies({ projectPath, document, files: [file], purpose: 'visible' });
  if (loaded.status !== 'ready') throw new Error('Expected review');
  return { document, body: loaded.files[file] };
}
