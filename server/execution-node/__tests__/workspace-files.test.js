import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileRevisionConflictError } from '../../execution-nodes/workspace-files.js';
import { getFileLockKey } from '../../files/file-revision.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import { resolveRealWithinBase } from '../../lib/path-boundary.js';
import { LocalWorkspaceFileService } from '../local-workspace-files.js';

const signal = () => new AbortController().signal;
const save = (content, expectedRevision, conflictResolution = 'reject') => ({ content, expectedRevision, conflictResolution });
let root;
let project;
let target;
let locks;
let files;

beforeEach(async () => {
  root = await mkdtemp(path.join(homedir(), 'garcon-workspace-files-'));
  project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'sample.txt'), 'synthetic original\n');
  target = { projectPath: project, filePath: 'sample.txt' };
  locks = new KeyedPromiseLock();
  files = new LocalWorkspaceFileService({ projectBasePath: root, saveLocks: locks });
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('node-local workspace files', () => {
  it('lists the owner base independently of the selected project and omits escaping aliases', async () => {
    const nested = path.join(project, 'nested');
    await mkdir(nested);
    await mkdir(path.join(project, 'node_modules'));
    await writeFile(path.join(nested, '.hidden.txt'), 'synthetic hidden\n');
    await writeFile(path.join(project, 'node_modules', 'ignored.txt'), 'synthetic ignored\n');
    await symlink(root, path.join(project, 'escape'));
    const scoped = new LocalWorkspaceFileService({
      projectBasePath: project, homeDirectoryPath: nested, saveLocks: locks,
    });
    const tree = await scoped.tree(null, signal());
    expect(tree.fileRootPath).toBe(await realpath(project));
    expect(tree.directory.parentPath).toBeNull();
    expect(tree.entries.map((entry) => entry.name)).toEqual(['nested', 'node_modules', 'sample.txt']);
    expect(tree.homeDirectory).toMatchObject({ path: nested });
    expect((await scoped.tree(nested, signal())).directory).toMatchObject({
      path: nested, relativePath: 'nested', parentPath: project,
      breadcrumbs: [{ name: 'project', path: project }, { name: 'nested', path: nested }],
    });
    expect(await scoped.browse(null, signal())).toEqual([{ name: 'nested', path: nested, type: 'directory' }]);
    expect(await scoped.list(project, signal())).toMatchObject({
      truncated: false,
      files: [
        { name: 'sample.txt', relativePath: 'sample.txt', type: 'file' },
        { name: '.hidden.txt', relativePath: 'nested/.hidden.txt', type: 'file' },
      ],
    });
  });

  it('does not disclose an owner-external Home or substitute it for an unavailable tree', async () => {
    const scoped = new LocalWorkspaceFileService({
      projectBasePath: project, homeDirectoryPath: root, saveLocks: locks,
    });
    expect((await scoped.tree(null, signal())).homeDirectory).toBeNull();
    await expect(scoped.tree(root, signal())).rejects.toMatchObject({ errorCode: 'outside_project_base' });
    await expect(scoped.tree(path.join(project, 'missing'), signal())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await scoped.browse(root, signal())).toEqual([]);
  });

  it('rejects cancellation after directory enumeration instead of returning an empty tree', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const controller = new AbortController();
    const scoped = new LocalWorkspaceFileService({
      projectBasePath: project, saveLocks: locks,
      listTreeDirectory: async () => { entered.resolve(); await release.promise; return []; },
    });
    const pending = scoped.tree(null, controller.signal);
    try {
      await entered.promise;
      controller.abort(new Error('synthetic cancellation'));
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toBe(controller.signal.reason);
    await expect(scoped.list(project, controller.signal)).rejects.toBe(controller.signal.reason);
    await expect(scoped.browse(null, controller.signal)).rejects.toBe(controller.signal.reason);
  });

  it('keeps identity, text, bytes and revisions on the same canonical resource', async () => {
    const identity = await files.identity(target, signal());
    expect(identity).toEqual({ success: true, identity: {
      canonicalFileRootPath: await realpath(project), normalizedRelativePath: 'sample.txt',
    } });
    const read = await files.readText(target, signal());
    expect(read.content).toBe('synthetic original\n');
    const content = await files.content(target, signal());
    expect(content.mimeType).toBe('text/plain');
    expect(new TextDecoder().decode(content.bytes)).toBe(read.content);
    expect(content.revision).toBe(read.revision);
    expect(await files.revision(target, signal())).toEqual({ status: 'ready', revision: read.revision });
    expect(await files.revision({ ...target, filePath: 'missing.txt' }, signal())).toEqual({ status: 'missing' });
  });

  it('resolves a captured canonical project under a symlinked configured base', async () => {
    const alias = path.join(root, 'base-alias');
    await symlink(project, alias);
    const aliased = new LocalWorkspaceFileService({ projectBasePath: alias, saveLocks: locks });
    expect(await aliased.inspectProject(project, signal())).toEqual({ kind: 'available', effectiveProjectKey: await realpath(project) });
    expect(await aliased.readText(target, signal())).toEqual(await files.readText(target, signal()));
  });

  it('does not use another owner root or follow an escaping file alias', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sample.txt'), 'synthetic outside\n');
    const scoped = new LocalWorkspaceFileService({ projectBasePath: project, saveLocks: locks });
    await expect(scoped.readText({ projectPath: outside, filePath: 'sample.txt' }, signal()))
      .rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE', reason: 'outside-base' });
    await symlink(path.join(outside, 'sample.txt'), path.join(project, 'escape.txt'));
    await expect(scoped.readText({ ...target, filePath: 'escape.txt' }, signal()))
      .rejects.toMatchObject({ errorCode: 'outside_project_base' });
    await expect(scoped.saveText({ ...target, filePath: 'escape.txt' }, save('forbidden', 'v1:old', 'overwrite'), signal()))
      .rejects.toMatchObject({ errorCode: 'outside_project_base' });
    expect(await readFile(path.join(outside, 'sample.txt'), 'utf8')).toBe('synthetic outside\n');
  });

  it('preserves revision conflicts and only overwrites after an explicit request', async () => {
    const original = await files.readText(target, signal());
    const first = await files.saveText(target, save('synthetic changed\n', original.revision), signal());
    expect(first.revision).not.toBe(original.revision);
    await expect(files.saveText(target, save('synthetic stale\n', original.revision), signal()))
      .rejects.toBeInstanceOf(FileRevisionConflictError);
    expect((await files.readText(target, signal())).content).toBe('synthetic changed\n');
    const overwritten = await files.saveText(target, save('synthetic overwrite\n', original.revision, 'overwrite'), signal());
    expect(await files.revision(target, signal())).toEqual({ status: 'ready', revision: overwritten.revision });
    expect((await files.readText(target, signal())).content).toBe('synthetic overwrite\n');
  });

  it.each([1, 2])('reports a cycle during save target resolution %i as a revision conflict', async (attempt) => {
    const alias = path.join(project, 'alias.txt');
    await symlink(path.join(project, 'sample.txt'), alias);
    let resolutions = 0;
    const gated = new LocalWorkspaceFileService({
      projectBasePath: root, saveLocks: locks,
      resolveSaveTarget: async (...args) => {
        if (++resolutions === attempt) {
          await rm(alias);
          await symlink(alias, alias);
        }
        return resolveRealWithinBase(...args);
      },
    });
    await expect(gated.saveText({ ...target, filePath: 'alias.txt' }, save('forbidden', 'v1:old', 'overwrite'), signal()))
      .rejects.toBeInstanceOf(FileRevisionConflictError);
    expect(resolutions).toBe(attempt);
    expect((await files.readText(target, signal())).content).toBe('synthetic original\n');
  });

  it.each(['hard-link', 'symlink'])('serializes two workspace services through one %s resource', async (aliasKind) => {
    const alias = path.join(project, 'alias.txt');
    const main = path.join(project, 'sample.txt');
    if (aliasKind === 'hard-link') await link(main, alias);
    else await symlink(main, alias);
    const other = new LocalWorkspaceFileService({ projectBasePath: project, saveLocks: locks });
    const original = await files.readText(target, signal());
    const results = await Promise.allSettled([
      files.saveText(target, save('synthetic first\n', original.revision), signal()),
      other.saveText({ ...target, filePath: 'alias.txt' }, save('synthetic second\n', original.revision), signal()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toBeInstanceOf(FileRevisionConflictError);
  });

  it('rejects a contained resource replacement while waiting for its lock, even for overwrite', async () => {
    const alternate = path.join(project, 'alternate.txt');
    await writeFile(alternate, 'synthetic alternate\n');
    const waiting = Promise.withResolvers();
    const release = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const key = await getFileLockKey(path.join(project, 'sample.txt'));
    const held = locks.runExclusive(key, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const gated = new LocalWorkspaceFileService({
      projectBasePath: root,
      saveLocks: { runExclusive: (...args) => { waiting.resolve(); return locks.runExclusive(...args); } },
    });
    const pending = gated.saveText(target, save('forbidden', 'v1:old', 'overwrite'), signal());
    const result = pending.catch((error) => error);
    try {
      await waiting.promise;
      await rm(path.join(project, 'sample.txt'));
      await symlink(alternate, path.join(project, 'sample.txt'));
    } finally {
      release.resolve();
      await held;
    }
    expect(await result).toBeInstanceOf(FileRevisionConflictError);
    expect(await readFile(alternate, 'utf8')).toBe('synthetic alternate\n');
  });

  it('cancels a waiting save without writing after the lock becomes available', async () => {
    const waiting = Promise.withResolvers();
    const release = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const key = await getFileLockKey(path.join(project, 'sample.txt'));
    const held = locks.runExclusive(key, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const gated = new LocalWorkspaceFileService({
      projectBasePath: root,
      saveLocks: { runExclusive: (...args) => { waiting.resolve(); return locks.runExclusive(...args); } },
    });
    const controller = new AbortController();
    const pending = gated.saveText(target, save('forbidden', 'v1:old', 'overwrite'), controller.signal);
    const result = pending.catch((error) => error);
    try {
      await waiting.promise;
      controller.abort(new Error('synthetic cancellation'));
    } finally {
      release.resolve();
      await held;
    }
    expect(await result).toBe(controller.signal.reason);
    expect((await files.readText(target, signal())).content).toBe('synthetic original\n');
  });

  it('captures target and save content before asynchronous path resolution', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const gated = new LocalWorkspaceFileService({
      projectBasePath: root, saveLocks: locks,
      resolveSaveTarget: async (...args) => { entered.resolve(); await release.promise; return resolveRealWithinBase(...args); },
    });
    const request = save('synthetic captured\n', 'v1:old', 'overwrite');
    const pending = gated.saveText(target, request, signal());
    try {
      await entered.promise;
      target.projectPath = '/not/the/captured/project';
      target.filePath = 'not-the-captured-file.txt';
      request.content = 'not the captured content';
      request.conflictResolution = 'reject';
    } finally {
      release.resolve();
    }
    expect((await pending).path).toBe(path.join(project, 'sample.txt'));
    expect(await readFile(path.join(project, 'sample.txt'), 'utf8')).toBe('synthetic captured\n');
  });

  it('rejects an already-aborted save before path resolution', async () => {
    const controller = new AbortController();
    controller.abort(new Error('synthetic cancellation'));
    let resolutions = 0;
    const gated = new LocalWorkspaceFileService({
      projectBasePath: root, saveLocks: locks,
      resolveSaveTarget: async (...args) => { resolutions += 1; return resolveRealWithinBase(...args); },
    });
    await expect(gated.saveText(target, save('forbidden', 'v1:old', 'overwrite'), controller.signal))
      .rejects.toBe(controller.signal.reason);
    expect(resolutions).toBe(0);
    expect((await files.readText(target, signal())).content).toBe('synthetic original\n');
  });
});
