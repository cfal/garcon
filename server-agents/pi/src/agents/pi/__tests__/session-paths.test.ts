import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  home = await mkdtemp(path.join(tmpdir(), 'pi-paths-'));
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
