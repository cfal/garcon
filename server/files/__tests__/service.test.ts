import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalExecutionFilesService } from '../service.js';
import { MAX_FILE_SAVE_BYTES } from '../../../common/file-contracts.js';

let directory: string;
let service: LocalExecutionFilesService;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-service-'));
  await fs.mkdir(path.join(directory, 'project'));
  await fs.writeFile(path.join(directory, 'project/file.txt'), 'initial');
  service = new LocalExecutionFilesService({ nodeId: 'synthetic-node', projectBasePath: directory });
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const target = () => ({ projectPath: path.join(directory, 'project'), filePath: 'file.txt' });

describe('node files service', () => {
  it('owns canonical identity, listing, browsing and bytes independently of providers', async () => {
    expect(await service.identity(target())).toEqual({ nodeId: 'synthetic-node', canonicalFileRootPath: target().projectPath, normalizedRelativePath: 'file.txt' });
    expect((await service.browse({})).map((item) => item.name)).toEqual(['project']);
    expect((await service.tree({ directoryPath: target().projectPath })).directory.relativePath).toBe('project');
    expect((await service.list({ projectPath: target().projectPath })).files.map((item) => item.relativePath)).toEqual(['file.txt']);
    const read = await service.read(target());
    expect(Buffer.from(read.bytes).toString()).toBe('initial');
    expect(await service.revision(target())).toEqual({ status: 'ready', revision: read.revision });
  });

  it('checks revisions under one save lock, including hard-link aliases', async () => {
    await fs.link(path.join(target().projectPath, 'file.txt'), path.join(target().projectPath, 'alias.txt'));
    const { revision } = await service.read(target());
    const results = await Promise.allSettled(['file.txt', 'alias.txt'].map((filePath) => service.save({ ...target(), filePath, content: filePath, expectedRevision: revision, conflictResolution: 'reject' })));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((item) => item.status === 'rejected');
    expect(rejected?.reason.code).toBe('FILE_REVISION_CONFLICT');
  });

  it('rejects escaping aliases and paths, and distinguishes missing files', async () => {
    await fs.writeFile(path.join(directory, 'outside.txt'), 'not in project');
    await fs.symlink(path.join(directory, 'outside.txt'), path.join(target().projectPath, 'alias.txt'));
    await expect(service.read({ ...target(), filePath: 'alias.txt' })).rejects.toMatchObject({ code: 'FILE_OUTSIDE_ROOT' });
    await expect(service.read({ ...target(), filePath: '../outside.txt' })).rejects.toMatchObject({ code: 'FILE_OUTSIDE_ROOT' });
    expect(await service.revision({ ...target(), filePath: 'missing' })).toEqual({ status: 'missing' });
    await expect(service.read({ ...target(), filePath: 'missing' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('keeps a read snapshot stable and rejects excessive saves before mutation', async () => {
    const snapshot = await service.read(target());
    await fs.writeFile(path.join(target().projectPath, 'file.txt'), 'external');
    expect(Buffer.from(snapshot.bytes).toString()).toBe('initial');
    await expect(service.save({ ...target(), content: 'x'.repeat(MAX_FILE_SAVE_BYTES + 1), expectedRevision: snapshot.revision, conflictResolution: 'overwrite' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await fs.readFile(path.join(target().projectPath, 'file.txt'), 'utf8')).toBe('external');
  });

  it('observes cancellation before file operations', async () => {
    await expect(service.read(target(), { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
