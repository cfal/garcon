import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GIT_MAX_REQUEST_BYTES, GIT_MAX_REQUEST_PATHS } from '../../../common/git-execution.js';
import { validateGitRequest } from '../../../common/git-request-validation.js';
import createGitRoutes from '../git.js';
import { LocalGitRuntime } from '../../git/node-service.js';
import { createGitOperations } from '../../git/git-service.js';
import { runGit } from '../../git/run.js';
import { gitServiceError } from '../../git/service-errors.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-input-boundaries-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await runGit(project, ['init', '-b', 'main']);
  await runGit(project, ['config', 'user.name', 'Synthetic Author']);
  await runGit(project, ['config', 'user.email', 'test@example.invalid']);
  await runGit(project, ['commit', '--allow-empty', '-m', 'initial']);
  const runtime = new LocalGitRuntime({ nodeId: 'local', instanceId: 'regression', projectBasePath: root, assertAvailable() {} });
  cleanups.push(() => runtime.dispose());
  const routes = createGitRoutes({}, {}, async () => runtime.git);
  async function post(operation, fields) {
    const url = new URL(`http://localhost/api/v1/git/${operation}`);
    return routes[url.pathname].POST(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, ...fields }),
    }), url);
  }
  return { root, project, runtime, routes, post };
}

test.each(['stage-paths', 'commit'])('accepts a 6000-path %s without dropping any paths', async (operation) => {
  const { project, post } = await fixture();
  const files = Array.from({ length: 6000 }, (_, index) => `file-${index.toString().padStart(6, '0')}-${'x'.repeat(29)}.txt`);
  for (let offset = 0; offset < files.length; offset += 32) {
    await Promise.all(files.slice(offset, offset + 32).map(file => fs.writeFile(path.join(project, file), 'synthetic\n')));
  }
  expect(files.every(file => file.length === 45)).toBe(true);
  const response = await post(operation, operation === 'commit'
    ? { files, message: 'selected synthetic files' } : { paths: files, mode: 'stage' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true });
  const args = operation === 'commit' ? ['ls-tree', '-r', '--name-only', '-z', 'HEAD'] : ['ls-files', '-z'];
  expect((await runGit(project, args)).stdout.split('\0').filter(Boolean).sort()).toEqual([...files].sort());
}, 30000);

test('large valid selections use the status path ceiling and return typed size errors', async () => {
  const { project, post } = await fixture();
  const files = Array.from({ length: 12_000 }, (_, index) => `file-${index}.txt`);
  expect(() => validateGitRequest('commit', { projectPath: project, files, message: 'synthetic' })).not.toThrow();
  for (const paths of [Array(GIT_MAX_REQUEST_PATHS + 1).fill('x'), Array(2000).fill('x'.repeat(3000))]) {
    const response = await post('stage-paths', { paths, mode: 'stage' });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ errorCode: 'GIT_REQUEST_TOO_LARGE' });
  }
  expect(GIT_MAX_REQUEST_BYTES).toBeLessThan(16 * 1024 * 1024);
  expect((await runGit(project, ['ls-files'])).stdout).toBe('');
});

test('a missing child of an escaping symlink never bypasses the node boundary', async () => {
  const { root, project, runtime } = await fixture();
  await fs.symlink(path.dirname(root), path.join(project, 'escape'));
  await expect(runtime.git.getQuickSummary({ projectPath: path.join(project, 'escape', 'synthetic-missing') }))
    .rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
  await fs.writeFile(path.join(root, 'outside-file'), 'synthetic');
  const restricted = new LocalGitRuntime({ nodeId: 'local', instanceId: 'restricted', projectBasePath: project, assertAvailable() {} });
  cleanups.push(() => restricted.dispose());
  await fs.symlink(path.join(root, 'outside-file'), path.join(project, 'file-link'));
  await expect(restricted.git.getQuickSummary({ projectPath: path.join(project, 'file-link', 'child') }))
    .rejects.toMatchObject({ code: 'GIT_OUTSIDE_BASE' });
});

test.each(['missing', 'non-directory-parent', 'dangling-symlink'])('missing-project reads preserve not-repository results: %s', async (kind) => {
  const { root, post } = await fixture();
  if (kind === 'non-directory-parent') await fs.writeFile(path.join(root, 'file'), 'synthetic');
  if (kind === 'dangling-symlink') await fs.symlink('missing-target', path.join(root, 'link'));
  const project = path.join(root, kind === 'missing' ? 'missing' : kind === 'dangling-symlink' ? 'link' : 'file/nested');
  for (const operation of ['quick-summary', 'working-tree/fingerprint', 'workbench/snapshot']) {
    const response = await post(operation, { project, ...(operation === 'workbench/snapshot' ? { mode: 'working', context: 2 } : {}) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'not-git-repository' });
  }
});

test.each(['getQuickSummary', 'getWorkingTreeFingerprint', 'getWorkbenchSnapshot'])('a missing project cannot become an unchecked repository during %s', async (method) => {
  const { project } = await fixture();
  const base = path.join(await fs.realpath(project), 'base');
  const appearing = path.join(base, 'appearing');
  await fs.mkdir(base);
  const runtime = new LocalGitRuntime({ nodeId: 'local', instanceId: 'appearing-project', projectBasePath: base, assertAvailable() {} });
  cleanups.push(() => runtime.dispose());
  const originalStat = fsPromises.stat;
  let projectStats = 0;
  const stat = spyOn(fsPromises, 'stat').mockImplementation(async (target, ...options) => {
    if (target === appearing && ++projectStats <= 2) {
      if (projectStats === 2) await fs.mkdir(appearing);
      throw Object.assign(new Error('Synthetic missing project'), { code: 'ENOENT' });
    }
    return originalStat(target, ...options);
  });
  cleanups.push(() => stat.mockRestore());
  expect(await runtime.git[method]({ projectPath: appearing,
    ...(method === 'getWorkbenchSnapshot' ? { mode: 'working', context: 2 } : {}),
  })).toMatchObject({ status: 'not-git-repository', nodeId: 'local' });
  expect(projectStats).toBe(1);
});

test('an invalid base beneath a regular file fails instead of exhausting admission', async () => {
  const { root } = await fixture();
  await fs.writeFile(path.join(root, 'file'), 'synthetic');
  const projectBasePath = path.join(root, 'file', 'base');
  const runtime = new LocalGitRuntime({ nodeId: 'local', instanceId: 'invalid-base', projectBasePath, assertAvailable() {} });
  cleanups.push(() => runtime.dispose());
  for (let attempt = 0; attempt < 9; attempt++) {
    await expect(runtime.git.getStatus({ projectPath: path.join(projectBasePath, 'project') }))
      .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT', status: 400, message: 'Git path is unavailable' });
  }
}, 5000);

test('Bun missing-executable errors remain distinct from missing paths', () => {
  const missingGit = Object.assign(new Error('Executable not found in $PATH: "git"'), { code: 'ENOENT' });
  expect(gitServiceError(missingGit)).toMatchObject({ code: 'GIT_MISSING', status: 501 });
  const missingDirectory = Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'git'"), { code: 'ENOENT' });
  expect(gitServiceError(missingDirectory)).toMatchObject({ code: 'GIT_INVALID_INPUT', status: 400, message: 'Git path is unavailable' });
});

test('missing status is a typed client error without filesystem diagnostics', async () => {
  const { root, routes } = await fixture();
  const url = new URL('http://localhost/api/v1/git/status');
  url.searchParams.set('project', path.join(root, 'missing'));
  const response = await routes[url.pathname].GET(new Request(url), url);
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.errorCode).toBe('GIT_NOT_REPO');
  expect(body.error).not.toContain(root);
});

test.each(['outside-project', 'dangling'])('discard restores a tracked symlink without following its %s target', async (kind) => {
  const { root, project, runtime } = await fixture();
  await fs.writeFile(path.join(project, 'inside'), 'synthetic');
  await fs.symlink('inside', path.join(project, 'link'));
  await runGit(project, ['add', 'inside', 'link']);
  await runGit(project, ['commit', '-m', 'tracked symlink']);
  await fs.unlink(path.join(project, 'link'));
  if (kind === 'outside-project') await fs.writeFile(path.join(root, 'outside'), 'untouched');
  await fs.symlink(kind === 'outside-project' ? '../outside' : 'absent', path.join(project, 'link'));
  expect(await runtime.git.discard({ projectPath: project, file: 'link' })).toMatchObject({ success: true });
  expect(await fs.readlink(path.join(project, 'link'))).toBe('inside');
  if (kind === 'outside-project') expect(await fs.readFile(path.join(root, 'outside'), 'utf8')).toBe('untouched');
});

test.each(['stageHunk', 'stageSelection'])('raw %s refuses missing displayed-patch provenance', async (method) => {
  const { project } = await fixture();
  await fs.writeFile(path.join(project, 'tracked'), 'old\n');
  await runGit(project, ['add', 'tracked']);
  await runGit(project, ['commit', '-m', 'tracked']);
  await fs.writeFile(path.join(project, 'tracked'), 'new\n');
  const operations = createGitOperations();
  await expect(operations[method]({ projectPath: project, file: 'tracked', mode: 'stage', contextLines: 2,
    ...(method === 'stageHunk' ? { hunkIndex: 0 } : { selection: { lineIndices: [0, 1] } }),
  })).rejects.toMatchObject({ code: 'STALE_DOCUMENT' });
  expect((await runGit(project, ['diff', '--cached'])).stdout).toBe('');
});
