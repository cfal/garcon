import { expect, test } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`untracked review and numeric staging use the same normalized patch (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-clean-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const project = fixture.executionDirs.project;
      const target = { nodeId: client.nodeId, project };
      await initializeFixtureRepository(project);
      await runFixtureGit(project, 'config', 'core.autocrlf', 'true');
      await runFixtureGit(project, 'config', 'diff.noprefix', 'true');
      await mkdir(join(project, 'nested'));
      for (const endpoint of ['stage-hunk', 'stage-selection']) {
        const file = `nested/${endpoint}.txt`;
        await writeFile(join(project, file), 'one\r\ntwo\r\nthree');
        const entriesBefore = await runFixtureGit(project, 'ls-files', '--stage', '-z');
        const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 2 });
        if (snapshot.status !== 'ready') throw new Error('Expected workbench');
        // Snapshot probes may refresh stat-cache metadata; loading a body must not write the index.
        const indexBefore = await readFile(join(project, '.git/index'));
        const document = { nodeId: client.nodeId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
        const bodies = await client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', { ...target, document, files: [file], purpose: 'visible' });
        if (bodies.status !== 'ready') throw new Error('Expected review');
        const body = bodies.files[file];
        expect(body.patch).toContain('+one\n+two\n+three\n\\ No newline at end of file');
        expect(await readFile(join(project, '.git/index'))).toEqual(indexBefore);
        expect(await runFixtureGit(project, 'ls-files', '--stage', '-z')).toBe(entriesBefore);
        await client.post(`/api/v1/git/${endpoint}`, {
          ...target, file, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest,
          mode: 'stage', contextLines: 2,
          ...(endpoint === 'stage-hunk' ? { hunkIndex: 0 } : { selection: { lineIndices: [1, 2] } }),
        });
        expect(await runFixtureGit(project, 'show', `:${file}`)).toBe(endpoint === 'stage-hunk' ? 'one\ntwo\nthree' : 'two\nthree');
        expect(await runFixtureGit(project, 'ls-files', '--', `${endpoint}.txt`)).toBe('');
        expect((await readdir(join(project, '.git'))).filter(name => name.startsWith('.garcon-index-'))).toEqual([]);
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
