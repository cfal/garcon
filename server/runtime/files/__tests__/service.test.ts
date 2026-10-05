import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FilesService } from '../service.js';
import { descriptorPathsDirectory } from '../directory-creation.js';
import type { ExecutionFilesService } from '@garcon/server-agent-interface';
import { ExecutionRuntime } from '../../execution-runtime.js';
import { runtimeAdapter, RUNTIME_BACKENDS } from '../../../remote/__tests__/runtime-adapter.js';
import { MAX_FILE_REVISION_LENGTH, MAX_FILE_SAVE_BYTES } from '../../../../common/file-contracts.js';

for (const backend of RUNTIME_BACKENDS) describe(`executor files service (${backend})`, () => {
let directory: string;
let service: ExecutionFilesService;
let runtime: ExecutionRuntime;
let adapter: Awaited<ReturnType<typeof runtimeAdapter>>;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-service-'));
  await fs.mkdir(path.join(directory, 'project'));
  await fs.writeFile(path.join(directory, 'project/file.txt'), 'initial');
  runtime = new ExecutionRuntime({ id: 'synthetic-executor', workspaceDir: directory, projectBasePath: directory, integrations: [], resolveCredential: async () => null });
  adapter = await runtimeAdapter(runtime, backend);
  service = await adapter.executor.getFilesService();
});
afterEach(async () => {
  await adapter.dispose();
  await runtime.dispose();
  await fs.rm(directory, { recursive: true, force: true });
});
const target = () => ({ projectPath: path.join(directory, 'project'), filePath: 'file.txt' });

  it('bounds process-wide reads and saves without blocking metadata calls', async () => {
    const released = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const original = fs.realpath;
    let calls = 0;
    const held = spyOn(fs, 'realpath').mockImplementation(async (...args) => {
      if (++calls <= 8) {
        if (calls === 8) entered.resolve();
        await released.promise;
      }
      return original(...args);
    });
    const reads = Array.from({ length: 8 }, () => service.read(target()));
    try {
      await entered.promise;
      const other = new FilesService({ executorId: 'other', projectBasePath: directory });
      await expect(other.read(target())).rejects.toMatchObject({ code: 'FILE_SERVICE_BUSY' });
      await expect(other.save({ ...target(), content: 'changed', expectedRevision: null, conflictResolution: 'overwrite' })).rejects.toMatchObject({ code: 'FILE_SERVICE_BUSY' });
      expect((await other.revision(target())).status).toBe('ready');
      expect((await other.identity(target())).normalizedRelativePath).toBe('file.txt');
      expect((await other.list(target())).files).toHaveLength(1);
      expect((await other.tree({})).entries).toHaveLength(1);
      expect(await other.browse({})).toHaveLength(1);
    } finally {
      released.resolve();
      await Promise.all(reads);
      held.mockRestore();
    }
    expect(Buffer.from((await service.read(target())).bytes).toString()).toBe('initial');
  });

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
    expect(await service.identity(target())).toEqual({ executorId: 'synthetic-executor', canonicalFileRootPath: target().projectPath, normalizedRelativePath: 'file.txt' });
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

  it('rejects oversized revisions before mutation even for explicit overwrites', async () => {
    for (const conflictResolution of ['reject', 'overwrite'] as const) {
      await expect(service.save({
        ...target(), content: 'changed', conflictResolution,
        expectedRevision: `v1:${'a'.repeat(MAX_FILE_REVISION_LENGTH - 2)}`,
      })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    }
    expect(await fs.readFile(path.join(target().projectPath, 'file.txt'), 'utf8')).toBe('initial');
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
      const outcome = first.then(result => result, error => error);
      await entered.promise;
      abort.abort();
      const replacement = new FilesService({ executorId: 'synthetic-executor', projectBasePath: directory });
      const second = replacement.save({ ...target(), content: 'replacement', expectedRevision: revision, conflictResolution: 'reject' });
      resume.resolve();
      if (backend === 'local') expect((await outcome).success).toBe(true);
      else expect(await outcome).toMatchObject({ code: 'FILE_SAVE_OUTCOME_UNKNOWN' });
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

  it.skipIf(descriptorPathsDirectory() !== null)('reports creation as unsupported where this system cannot create safely', async () => {
    const project = target().projectPath;
    for (const request of [{ parentPath: project, name: 'created' }, { parentPath: project, name: '..' }, { parentPath: path.join(project, 'absent'), name: 'child' }]) {
      await expect(service.createDirectory(request)).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', status: 501 });
    }
    expect((await runtime.getInfo()).services.directoryCreation).toBe(false);
    expect(await fs.readdir(project)).toEqual(['file.txt']);
  });

  // Creating needs a system that names open descriptors by path.
  describe.skipIf(descriptorPathsDirectory() === null)('directory creation', () => {
  it('creates one directory in its canonical parent and makes it browsable', async () => {
    const project = target().projectPath;
    await fs.symlink(project, path.join(directory, 'alias'));
    expect(await service.createDirectory({ parentPath: project, name: 'created' }))
      .toEqual({ name: 'created', path: path.join(project, 'created'), type: 'directory' });
    // Names are created exactly as given, including surrounding spaces.
    expect(await service.createDirectory({ parentPath: path.join(directory, 'alias'), name: 'via alias ' }))
      .toEqual({ name: 'via alias ', path: path.join(project, 'via alias '), type: 'directory' });
    expect(await service.browse({ directoryPath: project })).toEqual([
      { name: 'created', path: path.join(project, 'created'), type: 'directory' },
      { name: 'via alias ', path: path.join(project, 'via alias '), type: 'directory' },
    ]);
    expect(await fs.readdir(path.join(project, 'created'))).toEqual([]);
  });

  it('rejects creation that would replace, escape, or nest, leaving the filesystem unchanged', async () => {
    const project = target().projectPath;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-outside-'));
    try {
      await fs.symlink(outside, path.join(project, 'escape'));
      await fs.symlink(path.join(project, 'absent'), path.join(project, 'dangling'));
      for (const name of ['file.txt', 'escape', 'dangling']) {
        await expect(service.createDirectory({ parentPath: project, name })).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS', status: 409 });
      }
      await expect(service.createDirectory({ parentPath: directory, name: 'project' })).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS', status: 409 });
      for (const parentPath of [path.join(project, 'escape'), outside]) {
        await expect(service.createDirectory({ parentPath, name: 'child' })).rejects.toMatchObject({ code: 'FILE_OUTSIDE_ROOT', status: 403 });
      }
      await expect(service.createDirectory({ parentPath: path.join(project, 'absent'), name: 'child' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
      await expect(service.createDirectory({ parentPath: path.join(project, 'file.txt'), name: 'child' })).rejects.toMatchObject({ code: 'FILE_DIRECTORY_REQUIRED' });
      for (const name of ['', '.', '..', 'a/b', 'a\\b', '../child', 'tab\tname', 'x'.repeat(256)]) {
        await expect(service.createDirectory({ parentPath: project, name })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      }
      await expect(service.createDirectory({ parentPath: project, name: 'cancelled' }, { signal: AbortSignal.abort() })).rejects.toThrow();
      expect((await fs.readdir(project)).sort()).toEqual(['dangling', 'escape', 'file.txt']);
      expect(await fs.readdir(outside)).toEqual([]);
      expect(await fs.readFile(path.join(project, 'file.txt'), 'utf8')).toBe('initial');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  describe('with a parent swapped for a link during creation', () => {
    let outside: string;
    let parent: string;
    beforeEach(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-outside-'));
      parent = path.join(target().projectPath, 'a', 'b');
      await fs.mkdir(parent, { recursive: true });
      await fs.mkdir(path.join(outside, 'b'));
    });
    afterEach(async () => { await fs.rm(outside, { recursive: true, force: true }); });
    const moved = () => path.join(target().projectPath, 'a-moved');
    // Replaces an ancestor of the validated parent with a link that leads outside the base.
    const swapAncestor = async () => {
      await fs.rename(path.join(target().projectPath, 'a'), moved());
      await fs.symlink(outside, path.join(target().projectPath, 'a'));
    };

    it('creates in the validated directory when the swap lands immediately before creation', async () => {
      const mkdir = fs.mkdir;
      let swapped = false;
      const intercepted = spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
        if (!swapped && String(args[0]).endsWith('/child')) { swapped = true; await swapAncestor(); }
        return mkdir(...args);
      });
      try {
        expect(await service.createDirectory({ parentPath: parent, name: 'child' })).toMatchObject({ name: 'child', type: 'directory' });
      } finally { intercepted.mockRestore(); }
      expect(swapped).toBe(true);
      expect(await fs.readdir(path.join(outside, 'b'))).toEqual([]);
      expect(await fs.readdir(path.join(moved(), 'b'))).toEqual(['child']);
    });

    it('creates nothing when the swap lands before the parent is opened', async () => {
      const open = fs.open;
      let swapped = false;
      const intercepted = spyOn(fs, 'open').mockImplementation(async (...args) => {
        if (!swapped && args[0] === parent) { swapped = true; await swapAncestor(); }
        return open(...args);
      });
      try {
        await expect(service.createDirectory({ parentPath: parent, name: 'child' })).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT', status: 409 });
      } finally { intercepted.mockRestore(); }
      expect(swapped).toBe(true);
      expect(await fs.readdir(path.join(outside, 'b'))).toEqual([]);
      expect(await fs.readdir(path.join(moved(), 'b'))).toEqual([]);
    });

    it('creates nothing when the parent itself becomes a link before it is opened', async () => {
      const open = fs.open;
      let swapped = false;
      const intercepted = spyOn(fs, 'open').mockImplementation(async (...args) => {
        if (!swapped && args[0] === parent) {
          swapped = true;
          await fs.rename(parent, `${parent}-moved`);
          await fs.symlink(path.join(outside, 'b'), parent);
        }
        return open(...args);
      });
      try {
        await expect(service.createDirectory({ parentPath: parent, name: 'child' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
      } finally { intercepted.mockRestore(); }
      expect(swapped).toBe(true);
      expect(await fs.readdir(path.join(outside, 'b'))).toEqual([]);
      expect(await fs.readdir(`${parent}-moved`)).toEqual([]);
    });
  });

  it('accepts the longest name and reports a denied creation as definite', async () => {
    const project = target().projectPath;
    const longest = 'é'.repeat(127) + 'x';
    expect((await service.createDirectory({ parentPath: project, name: longest })).name).toBe(longest);
    const mkdir = spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      await expect(service.createDirectory({ parentPath: project, name: 'denied' })).rejects.toMatchObject({ code: 'FILE_PERMISSION_DENIED', status: 403 });
      expect(mkdir).toHaveBeenCalledTimes(1);
    } finally { mkdir.mockRestore(); }
    await expect(fs.stat(path.join(project, 'denied'))).rejects.toThrow();
  });
  });
});

// Validation runs before any descriptor is used, so an injected location
// covers it on systems that cannot create.
describe('directory creation validation', () => {
  let base: string;
  let outside: string;
  let service: FilesService;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-validation-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-outside-'));
    await fs.mkdir(path.join(base, 'project'));
    await fs.writeFile(path.join(base, 'project', 'file.txt'), 'initial');
    await fs.symlink(outside, path.join(base, 'project', 'escape'));
    service = new FilesService({ executorId: 'synthetic-executor', projectBasePath: base, descriptorPaths: descriptorPathsDirectory() ?? '/garcon-injected-descriptor-paths' });
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('rejects names and parents that cannot hold one new child, before creating anything', async () => {
    const project = path.join(base, 'project');
    const mkdir = spyOn(fs, 'mkdir');
    try {
      for (const name of ['', '.', '..', 'a/b', 'a\\b', '../child', 'tab\tname', 'x'.repeat(256)]) {
        await expect(service.createDirectory({ parentPath: project, name })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      }
      await expect(service.createDirectory({ parentPath: '', name: 'child' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      for (const parentPath of [path.join(project, 'escape'), outside]) {
        await expect(service.createDirectory({ parentPath, name: 'child' })).rejects.toMatchObject({ code: 'FILE_OUTSIDE_ROOT', status: 403 });
      }
      await expect(service.createDirectory({ parentPath: path.join(project, 'absent'), name: 'child' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
      await expect(service.createDirectory({ parentPath: path.join(project, 'file.txt'), name: 'child' })).rejects.toMatchObject({ code: 'FILE_DIRECTORY_REQUIRED' });
      await expect(service.createDirectory({ parentPath: project, name: 'cancelled' }, { signal: AbortSignal.abort() })).rejects.toThrow();
      expect(mkdir).not.toHaveBeenCalled();
    } finally { mkdir.mockRestore(); }
    expect((await fs.readdir(project)).sort()).toEqual(['escape', 'file.txt']);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

// Stands in for macOS, Windows, and Linux without procfs, none of which can
// create relative to an opened directory from this runtime.
describe.each([
  ['a platform without descriptor paths', null],
  ['a system whose descriptor paths are missing', '/garcon-missing-descriptor-paths'],
] as const)('directory creation on %s', (_label, descriptorPaths) => {
  let base: string;
  let outside: string;
  let parent: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-unsupported-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-files-outside-'));
    parent = path.join(base, 'a', 'b');
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(path.join(outside, 'b'));
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('creates nothing when the parent is swapped for an outside link after the last check', async () => {
    const service = new FilesService({ executorId: 'synthetic-executor', projectBasePath: base, descriptorPaths });
    const stat = fs.stat;
    let swapped = false;
    // The directory check on the validated parent is the last one before any creation could run.
    const lastCheck = spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (!swapped && args[0] === parent) {
        swapped = true;
        await fs.rename(path.join(base, 'a'), path.join(base, 'a-moved'));
        await fs.symlink(outside, path.join(base, 'a'));
      }
      return result;
    });
    const mkdir = spyOn(fs, 'mkdir');
    try {
      await expect(service.createDirectory({ parentPath: parent, name: 'child' })).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', status: 501 });
      expect(mkdir).not.toHaveBeenCalled();
    } finally { lastCheck.mockRestore(); mkdir.mockRestore(); }
    // A platform known to lack descriptor paths refuses before it looks at the parent at all.
    expect(swapped).toBe(descriptorPaths !== null);
    expect(await fs.readdir(path.join(outside, 'b'))).toEqual([]);
    expect(await fs.readdir(path.join(base, swapped ? 'a-moved' : 'a', 'b'))).toEqual([]);
  });

  it('still lists directories', async () => {
    const service = new FilesService({ executorId: 'synthetic-executor', projectBasePath: base, descriptorPaths });
    expect(await service.browse({ directoryPath: path.join(base, 'a') })).toEqual([{ name: 'b', path: parent, type: 'directory' }]);
  });
});
