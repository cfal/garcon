import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentCallError } from '@garcon/server-agent-interface';
import { FILE_CONTEXT_SEPARATOR, stripResolvedFileMentionContext } from '@garcon/common/file-mention-context';
import { ProjectService } from '../project-service.js';
import { toNativePath, toExecutorPath } from '../../../common/executor-path.js';
import { isWithinExecutorPath } from '../../../../common/executor-path.js';
import { remoteFixture } from '../../../remote/__tests__/integration-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'executor-projects-'));
  roots.push(root);
  const base = join(root, 'worker');
  const project = join(base, 'project');
  await mkdir(project, { recursive: true });
  let disposed = false;
  const service = new ProjectService(base, (options) => {
    options?.signal?.throwIfAborted();
    if (disposed) throw new AgentCallError('not-dispatched', 'Disposed');
  });
  return { root, base, project, service, dispose() { disposed = true; } };
}

test('project inspection owns canonicalization, boundaries, and the optional Git probe', async () => {
  const f = await fixture();
  await writeFile(join(f.base, 'file'), 'content');
  await symlink(f.project, join(f.base, 'alias'));
  await symlink(f.root, join(f.base, 'escape'));
  expect(await f.service.inspect({ projectPath: 'alias' })).toEqual({
    resolution: { kind: 'available', effectiveProjectKey: f.project },
  });
  expect(await f.service.inspect({ projectPath: f.project, includeGitRepository: true })).toEqual({
    resolution: { kind: 'available', effectiveProjectKey: f.project }, isGitRepository: false,
  });
  for (const [projectPath, reason] of [['missing', 'not-found'], ['file', 'not-a-directory'], ['../', 'outside-base'], ['escape', 'outside-base']]) {
    expect(await f.service.inspect({ projectPath })).toEqual({ resolution: { kind: 'unavailable', reason } });
  }
  const initialized = Bun.spawn(['git', 'init', '--quiet', f.project], { stdout: 'ignore', stderr: 'pipe' });
  expect(await initialized.exited).toBe(0);
  expect((await f.service.inspect({ projectPath: f.project, includeGitRepository: true })).isGitRepository).toBe(true);
});

test('a symlinked configured base accepts its own canonical project paths', async () => {
  const f = await fixture();
  const alias = join(f.root, 'worker-alias');
  await symlink(f.base, alias);
  const service = new ProjectService(alias, () => {});
  expect((await service.inspect({ projectPath: f.project })).resolution).toEqual({ kind: 'available', effectiveProjectKey: f.project });
});

test('file mentions read worker content with unchanged bounds and sanitation', async () => {
  const f = await fixture();
  await writeFile(join(f.project, 'input.txt'), 'worker-only content');
  await writeFile(join(f.project, 'binary'), new Uint8Array([0, 1]));
  await writeFile(join(f.project, 'large'), 'a'.repeat(140 * 1024));
  await writeFile(join(f.root, 'outside'), 'must not leave worker base');
  await symlink(join(f.root, 'outside'), join(f.project, 'escape'));
  const command = 'Read @input.txt @binary @large @escape @missing';
  const result = await f.service.resolveFileMentions({ command, projectPath: f.project });
  expect(result.startsWith(command + FILE_CONTEXT_SEPARATOR)).toBe(true);
  expect(result).toContain('worker-only content');
  expect(result).toContain('[Garcon omitted this binary file.]');
  expect(result).toContain('[Garcon truncated this file at 131072 bytes.]');
  expect(result).not.toContain('must not leave worker base');
  expect(stripResolvedFileMentionContext(result)).toBe(command);
  await expect(f.service.resolveFileMentions({ command: '@outside', projectPath: f.root })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  f.dispose();
  await expect(f.service.inspect({ projectPath: f.project })).rejects.toMatchObject({ outcome: 'not-dispatched' });
});

test('portable path conversion preserves roots, spaces, Unicode, and POSIX backslashes', () => {
  const windows = ['C:\\', 'C:\\Projects\\with space', '\\\\server\\share\\project', 'D:\\Projects\\\u03bb'];
  for (const native of windows) {
    const portable = toExecutorPath(native, '\\');
    expect(toNativePath(portable, '\\')).toBe(native);
    expect(toNativePath(portable, '/')).toBe(portable);
  }
  for (const native of ['/', '/home/project with space', '/home/\u03bb', '/home/literal\\name']) {
    expect(toExecutorPath(native, '/')).toBe(native);
    expect(toNativePath(native, '/')).toBe(native);
  }
  expect(toExecutorPath('\\\\server\\share\\', '\\')).toBe('//server/share/');
  expect(isWithinExecutorPath('C:/', 'C:/project')).toBe(true);
  expect(isWithinExecutorPath('//server/share', '//server/shared/project')).toBe(false);
});

for (const dialer of ['controller', 'worker'] as const) {
  test(`project service uses the current worker session without local fallback (${dialer} dials)`, async () => {
    const f = await fixture();
    await writeFile(join(f.project, 'input.txt'), 'remote content');
    const remote = await remoteFixture(dialer, () => {}, f.base);
    try {
      const projects = await remote.executor.getProjectService();
      expect((await remote.executor.getInfo()).projectBasePath).toBe(f.base);
      expect(await projects.inspect({ projectPath: 'project' })).toEqual({
        resolution: { kind: 'available', effectiveProjectKey: f.project },
      });
      expect(await projects.ticketProjectDefault({ projectPath: 'project' })).toEqual({ project: 'project', kind: 'folder' });
      await expect(projects.ticketProjectDefault({ projectPath: f.root })).rejects.toThrow();
      await expect(projects.ticketProjectDefault({ projectPath: 42 } as never)).rejects.toThrow();
      const request = { command: 'Read @input.txt', projectPath: f.project };
      expect(await projects.resolveFileMentions(request)).toContain('remote content');
      remote.controller.disconnect(); remote.worker.disconnect();
      await expect(projects.ticketProjectDefault({ projectPath: f.project }))
        .rejects.toMatchObject({ outcome: 'not-dispatched' });
      await expect(Promise.resolve().then(() => projects.resolveFileMentions(request)))
        .rejects.toMatchObject({ outcome: 'not-dispatched' });
      const ready = Promise.withResolvers<void>();
      const off = remote.executor.onAvailabilityChanged((value) => {
        if (value === 'ready') { off(); ready.resolve(); }
      });
      await ready.promise;
      expect(remote.generations).toHaveLength(1);
      expect(await remote.executor.getProjectService()).toBe(projects);
      await writeFile(join(f.project, 'input.txt'), 'replacement content');
      expect(await projects.resolveFileMentions(request)).toContain('replacement content');
      expect(remote.generations.every((generation) => generation.calls.start === 0)).toBe(true);
    } finally { await remote.dispose(); }
  });
}
