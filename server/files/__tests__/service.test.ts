import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
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
  it('browses directories without collecting or budgeting unrelated file metadata', async () => {
    const project = target().projectPath;
    await fs.mkdir(path.join(project, 'folder'));
    for (let i = 0; i < 1800; i++) await fs.writeFile(path.join(project, `${i}-${'x'.repeat(220)}`), '');
    await expect(service.tree({ directoryPath: project })).rejects.toMatchObject({ code: 'FILE_LIST_TOO_LARGE' });
    const stat = spyOn(fs, 'stat');
    try {
      expect(await service.browse({ directoryPath: project })).toEqual([
        { name: 'folder', path: path.join(project, 'folder'), type: 'directory' },
      ]);
      expect(stat.mock.calls.map(([file]) => file)).toEqual([project, path.join(project, 'folder')]);
    } finally { stat.mockRestore(); }
  });

  it('keeps directory aliases within the root and excludes files and skipped directories', async () => {
    const project = target().projectPath;
    await fs.mkdir(path.join(project, 'folder'));
    await fs.mkdir(path.join(project, 'node_modules'));
    await fs.symlink(path.join(project, 'folder'), path.join(project, 'alias'));
    await fs.symlink(path.join(project, 'file.txt'), path.join(project, 'file-alias'));
    await fs.symlink(path.dirname(directory), path.join(project, 'escape'));
    expect((await service.browse({ directoryPath: project })).map(({ name }) => name)).toEqual(['alias', 'folder']);
    await expect(service.browse({ directoryPath: path.join(project, 'file.txt') })).rejects.toMatchObject({ code: 'FILE_DIRECTORY_REQUIRED' });
    await expect(service.browse({ directoryPath: path.dirname(directory) })).rejects.toMatchObject({ code: 'FILE_OUTSIDE_ROOT' });
    await expect(service.browse({}, { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it('skips unreadable descendants without concealing root failures or cancellation', async () => {
    const child = path.join(target().projectPath, 'private');
    await fs.mkdir(child);
    const open = fs.opendir;
    const intercepted = spyOn(fs, 'opendir').mockImplementation(async (...args) => {
      if (args[0] === child) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return open(...args);
    });
    try {
      expect((await service.list(target())).files.map((file) => file.name)).toEqual(['file.txt']);
      await expect(service.list({ projectPath: child })).rejects.toMatchObject({ code: 'FILE_PERMISSION_DENIED' });
      const abort = new AbortController();
      intercepted.mockImplementation(async (...args) => {
        if (args[0] === child) { abort.abort(); throw abort.signal.reason; }
        return open(...args);
      });
      await expect(service.list(target(), { signal: abort.signal })).rejects.toThrow();
    } finally { intercepted.mockRestore(); }
  });

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

  it('serializes a replacement service behind an already dispatched, cancelled save', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalOpen = fs.open;
    let held = false;
    const intercepted = spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!held && typeof args[1] === 'number' && (args[1] & 1)) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return originalOpen(...args);
    });
    try {
      const { revision } = await service.read(target());
      const abort = new AbortController();
      const first = service.save({ ...target(), content: 'retired', expectedRevision: revision, conflictResolution: 'reject' }, { signal: abort.signal });
      await entered.promise;
      abort.abort();
      const replacement = new LocalExecutionFilesService({ nodeId: 'synthetic-node', projectBasePath: directory });
      const second = replacement.save({ ...target(), content: 'replacement', expectedRevision: revision, conflictResolution: 'reject' });
      resume.resolve();
      expect((await first).success).toBe(true);
      await expect(second).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' });
      const current = await replacement.read(target());
      await replacement.save({ ...target(), content: 'replacement', expectedRevision: current.revision, conflictResolution: 'reject' });
      expect(await fs.readFile(path.join(target().projectPath, 'file.txt'), 'utf8')).toBe('replacement');
    } finally { resume.resolve(); intercepted.mockRestore(); }
  });

  it('distinguishes a denied open from an uncertain post-open write', async () => {
    const { revision } = await service.read(target());
    const request = { ...target(), content: 'replacement', expectedRevision: revision, conflictResolution: 'reject' as const };
    const originalOpen = fs.open;
    const intercepted = spyOn(fs, 'open').mockImplementation(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    try {
      await expect(service.save(request)).rejects.toMatchObject({ code: 'FILE_PERMISSION_DENIED' });
      expect(await fs.readFile(path.join(target().projectPath, 'file.txt'), 'utf8')).toBe('initial');
      intercepted.mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
        return handle;
      });
      await expect(service.save(request)).rejects.toMatchObject({ code: 'FILE_SAVE_OUTCOME_UNKNOWN' });
    } finally { intercepted.mockRestore(); }
  });
});
