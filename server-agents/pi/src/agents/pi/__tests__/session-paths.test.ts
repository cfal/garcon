import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PiConfig } from '../../../config.js';
import { findPiSessionFileBySessionId, nativePiWindowsPath } from '../pi-session-paths.js';

let home: string;
let project: string;
let override: string | null;
const config: PiConfig = {
  binary: () => 'pi', homeDirectory: () => home, agentDirectoryOverride: () => '~/agent',
  sessionDirectoryOverride: () => override, isTestEnvironment: () => true,
};
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-paths-')));
  project = path.join(home, 'project');
  override = null;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function put(file: string, contents: object) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(contents));
  return file;
}
const lookup = () => findPiSessionFileBySessionId('test', project, config);
const header = { type: 'session', id: 'test' };

test('resolves env, project and global session directories in order, including renamed files', async () => {
  const projectHeader = { ...header, cwd: project };
  const globalFile = await put(path.join(home, 'global', 'renamed.jsonl'), projectHeader);
  await mkdir(path.join(home, 'agent'), { recursive: true });
  await writeFile(path.join(home, 'agent', 'settings.json'), '\uFEFF{"sessionDir":"~/global"}');
  expect(await lookup()).toBe(globalFile);
  const projectFile = await put(path.join(project, 'local', 'date_test.jsonl'), projectHeader);
  await put(path.join(project, '.pi', 'settings.json'), { sessionDir: 'local' });
  expect(await lookup()).toBe(projectFile);
  const explicitDir = path.join(home, 'explicit sessions');
  override = pathToFileURL(explicitDir).href;
  expect(await lookup()).toBeNull();
  const timestamp = '2026-01-01T00-00-00-000Z';
  await put(path.join(explicitDir, `${timestamp}_other_test.jsonl`), { ...projectHeader, id: 'other_test' });
  const archived = await put(path.join(explicitDir, `${timestamp}_archived.jsonl`), projectHeader);
  expect(await lookup()).toBe(archived);
  await put(path.join(explicitDir, `${timestamp}_test.jsonl`), projectHeader);
  await expect(lookup()).rejects.toThrow('duplicate');
});

test('ignores invalid project settings and never imports another project from a shared directory', async () => {
  const directory = path.join(home, 'shared');
  await put(path.join(home, 'agent', 'settings.json'), { sessionDir: directory });
  const settings = await put(path.join(project, '.pi', 'settings.json'), {});
  await put(path.join(directory, 'other_test.jsonl'), { ...header, cwd: path.join(home, 'other') });
  await writeFile(path.join(directory, 'unrelated.jsonl'), 'x'.repeat(1024 * 1024 + 1));
  expect(await lookup()).toBeNull();
  const ownFile = await put(path.join(directory, 'project_test.jsonl'), { ...header, cwd: project });
  for (const invalid of ['', '{broken']) {
    await writeFile(settings, invalid);
    expect(await lookup()).toBe(ownFile);
  }
  await writeFile(settings, '{"sessionDir":null}');
  expect(await lookup()).toBeNull();
});

test('normalizes Windows shell drive prefixes without changing UNC or native paths', () => {
  for (const root of ['/c', '/mnt/c', '/cygdrive/c']) {
    expect(nativePiWindowsPath(`${root}/project`)).toBe('C:\\project');
  }
  for (const native of ['//server/share', 'D:\\project', '/ordinary/path']) {
    expect(nativePiWindowsPath(native)).toBe(native);
  }
});

test('matches the physical cwd Pi records for a symlinked project in a shared session directory', async () => {
  const physical = path.join(home, 'targets', 'physical');
  await mkdir(physical, { recursive: true });
  await symlink(physical, project, 'dir');
  override = '../shared';
  const shared = path.resolve(physical, override);
  const file = await put(path.join(shared, 'physical.jsonl'), { ...header, cwd: physical });
  await put(path.join(shared, 'unrelated.jsonl'), { ...header, cwd: home });
  expect(await lookup()).toBe(file);
  await put(file, { ...header, cwd: project });
  expect(await lookup()).toBe(file);
});

test('finds relocated project session directories without mistaking two paths to one file for duplicates', async () => {
  const root = path.join(home, 'agent', 'sessions');
  await mkdir(root, { recursive: true });
  const archive = path.join(home, 'archive');
  const file = await put(path.join(archive, 'session.jsonl'), header);
  await symlink(file, path.join(root, 'not-a-directory'), 'file');
  await symlink(archive, path.join(root, '--old-project--'), 'dir');
  await symlink(archive, path.join(root, '--other-alias--'), 'dir');
  const match = await lookup();
  expect(match && await realpath(match)).toBe(await realpath(file));
  await put(path.join(root, '--distinct--', 'session.jsonl'), header);
  await expect(lookup()).rejects.toThrow('duplicate');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable sibling cannot hide a verified session or prove a missing one', async () => {
  const root = path.join(home, 'agent', 'sessions');
  const locked = path.join(root, '--locked--');
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0);
  try {
    await expect(lookup()).rejects.toMatchObject({ code: 'EACCES' });
    const file = await put(path.join(root, '--other--', 'session.jsonl'), header);
    expect(await lookup()).toBe(file);
    override = locked;
    await expect(lookup()).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    await chmod(locked, 0o700);
  }
});

test('bounds the whole header scan, not just individual lines or the size of the file', async () => {
  override = path.join(home, 'shared');
  const contents = { ...header, cwd: project };
  const file = await put(path.join(override, 'renamed.jsonl'), contents);
  const blankLines = (' '.repeat(1023) + '\n').repeat(1024);
  await writeFile(file, blankLines + JSON.stringify(contents));
  expect(await lookup()).toBeNull();
  await writeFile(file, JSON.stringify(contents) + '\n' + blankLines);
  expect(await lookup()).toBe(file);
  await writeFile(file, JSON.stringify(contents).padEnd(blankLines.length, ' '));
  expect(await lookup()).toBe(file);
});

test('looks in the default session root and refuses ambiguous or unproved identity', async () => {
  const root = path.join(home, 'agent', 'sessions');
  const first = await put(path.join(root, '--other--', 'renamed.jsonl'), header);
  expect(await lookup()).toBe(first);
  const second = await put(path.join(root, '--sibling--', 'date_test.jsonl'), header);
  await expect(lookup()).rejects.toThrow('duplicate');
  await put(second, { ...header, id: 'wrong' });
  await expect(lookup()).rejects.toThrow('header');
  await rm(second);
  await symlink(first, second);
  await expect(lookup()).rejects.toThrow('regular file');
});
