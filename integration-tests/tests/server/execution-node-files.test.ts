import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadTextResponse, SaveTextResponse, FileIdentityResponse } from '../../../common/file-contracts.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`file HTTP operations use the selected worker (${backend})`, async () => {
    await withIntegrationFixture(`files-${backend}`, async (fixture) => {
      const { client } = fixture;
      const nodeId = client.nodeId;
      const projectPath = fixture.executionDirs.project;
      await mkdir(join(projectPath, 'folder'));
      const privateDirectory = join(projectPath, 'private');
      await mkdir(privateDirectory);
      await chmod(privateDirectory, 0);
      const content = 'file contents\n'.repeat(1_300_000);
      await writeFile(join(projectPath, 'file.txt'), content);
      await writeFile(join(fixture.dirs.project, 'file.txt'), 'controller file');
      const query = new URLSearchParams({ nodeId, projectPath, path: 'file.txt' });
      const result = await client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(result.content === content).toBe(true);
      const identity = await client.get<FileIdentityResponse>(`/api/v1/files/identity?${query}`);
      try {
        const listed = await client.get<Array<{ name: string }>>(`/api/v1/files/list?${query}`);
        expect(listed.some((file) => file.name === 'file.txt')).toBe(true);
      } finally { await chmod(privateDirectory, 0o700); }
      expect(identity.identity).toMatchObject({ nodeId, canonicalFileRootPath: projectPath, normalizedRelativePath: 'file.txt' });
      expect(await client.get(`/api/v1/files/browse?nodeId=${nodeId}&path=${encodeURIComponent(projectPath)}`)).toContainEqual({ name: 'folder', path: join(projectPath, 'folder'), type: 'directory' });
      const saved = await client.put<SaveTextResponse>(`/api/v1/files/text?${query}`, { content: `${content}saved`, expectedRevision: result.revision, conflictResolution: 'reject' });
      expect(saved.revision).not.toBe(result.revision);
      expect((await readFile(join(projectPath, 'file.txt'), 'utf8')) === `${content}saved`).toBe(true);
      expect(await readFile(join(fixture.dirs.project, 'file.txt'), 'utf8')).toBe('controller file');
      await expect(client.put(`/api/v1/files/text?${query}`, { content: 'stale', expectedRevision: result.revision, conflictResolution: 'reject' })).rejects.toMatchObject({ status: 409, body: { errorCode: 'FILE_REVISION_CONFLICT' } });
      const wrongRoot = new URLSearchParams({ nodeId, projectPath: fixture.dirs.project, path: 'file.txt' });
      await expect(client.get(`/api/v1/files/text?${wrongRoot}`)).rejects.toMatchObject({ status: 403 });
      for (const route of ['git/status', 'terminals']) {
        await expect(client.get(`/api/v1/${route}?nodeId=${nodeId}&projectPath=${encodeURIComponent(projectPath)}`)).rejects.toMatchObject({ status: 501 });
      }
      await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
      const restarted = await fixture.client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(restarted.content === `${content}saved`).toBe(true);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);
}
