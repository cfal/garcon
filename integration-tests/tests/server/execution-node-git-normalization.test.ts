import { expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`numeric staging preserves normalized additions and type-change sections (${executionBackend})`, async () => {
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
      for (const endpoint of ['stage-hunk', 'stage-selection']) {
        const file = `nested/${endpoint}-type.txt`;
        await writeFile(join(project, file), 'first\nsecond\nthird\n');
        await runFixtureGit(project, 'add', '--', file);
        await runFixtureGit(project, 'commit', '-m', 'Record regular file');
        await rm(join(project, file));
        await symlink('target.txt', join(project, file));
        const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 2 });
        if (snapshot.status !== 'ready') throw new Error('Expected type-change snapshot');
        const document = { nodeId: client.nodeId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
        const bodies = await client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', { ...target, document, files: [file], purpose: 'visible' });
        if (bodies.status !== 'ready') throw new Error('Expected type-change review');
        const body = bodies.files[file];
        expect(body.patch?.match(/^diff --git /gm)).toHaveLength(2);
        await client.post(`/api/v1/git/${endpoint}`, {
          ...target, file, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest,
          mode: 'stage', contextLines: 2,
          ...(endpoint === 'stage-hunk' ? { hunkIndex: 0 } : { selection: { lineIndices: [0] } }),
        });
        expect(await runFixtureGit(project, 'show', `:${file}`)).toBe(endpoint === 'stage-hunk' ? '' : 'second\nthird\n');
        expect(await runFixtureGit(project, 'ls-files', '-s', '--', file)).toStartWith('100644 ');
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
