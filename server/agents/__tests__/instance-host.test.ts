import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { IntegrationHostFactory } from '../integration-host.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-instance-host-'));
  directories.push(directory);
  const options = { workspaceDir: directory, loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
  return { directory, options };
}

test('separate same-provider factories retain isolated roots and declared environments', async () => {
  const f = await fixture();
  const personal = new IntegrationHostFactory({ ...f.options, instance: { id: 'synthetic-personal', agentId: 'alpha' },
    readEnvironment: (key) => key === 'ALPHA_HOME' ? '/synthetic/personal' : undefined });
  const work = new IntegrationHostFactory({ ...f.options, instance: { id: 'synthetic-work', agentId: 'alpha' },
    readEnvironment: (key) => key === 'ALPHA_HOME' ? '/synthetic/work' : undefined });
  const a = personal.forAgent('alpha');
  const b = work.forAgent('alpha');
  personal.bindConfiguration('alpha', ['ALPHA_HOME']);
  work.bindConfiguration('alpha', ['ALPHA_HOME']);
  expect(a.environment.get('ALPHA_HOME')).toBe('/synthetic/personal');
  expect(b.environment.get('ALPHA_HOME')).toBe('/synthetic/work');
  expect(() => a.environment.get('UNDECLARED')).toThrow();
  expect(() => personal.forAgent('beta')).toThrow();
  expect(personal.forAgent('alpha')).toBe(a);
  const [aRoot, bRoot] = await Promise.all([a.storage.directory('sessions'), b.storage.directory('sessions')]);
  expect(aRoot).toBe(path.join(f.directory, 'agent-data', 'instances', 'synthetic-personal', 'sessions'));
  expect(bRoot).toBe(path.join(f.directory, 'agent-data', 'instances', 'synthetic-work', 'sessions'));
  await writeFile(path.join(aRoot, 'synthetic-session'), 'synthetic personal content');
  await writeFile(path.join(bRoot, 'synthetic-session'), 'synthetic work content');
  expect(await readFile(path.join(aRoot, 'synthetic-session'), 'utf8')).toBe('synthetic personal content');
  expect(await readFile(path.join(bRoot, 'synthetic-session'), 'utf8')).toBe('synthetic work content');
});

test('new instances cannot claim a default providers legacy workspace storage', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'legacy-sessions'));
  await writeFile(path.join(f.directory, 'legacy-sessions', 'synthetic-session'), 'synthetic legacy content');
  const instance = new IntegrationHostFactory({ ...f.options, instance: { id: 'synthetic-profile', agentId: 'alpha' } }).forAgent('alpha');
  expect(await instance.storage.claimLegacyWorkspaceDirectory('legacy-sessions')).toEqual({ moved: 0, skipped: 0 });
  const standalone = new IntegrationHostFactory(f.options).forAgent('alpha');
  expect(standalone.storage.rootDirectory).toBe(path.join(f.directory, 'agent-data', 'alpha'));
  expect(await standalone.storage.claimLegacyWorkspaceDirectory('legacy-sessions')).toEqual({ moved: 1, skipped: 0 });
  expect(await readFile(path.join(standalone.storage.rootDirectory, 'legacy-sessions', 'synthetic-session'), 'utf8')).toBe('synthetic legacy content');
});

test.each(['agent-data', 'instances', 'synthetic-profile'] as const)('instance roots cannot escape through a symlink at %s', async (component) => {
  const f = await fixture();
  const parts = ['agent-data', 'instances', 'synthetic-profile'];
  const target = path.join(f.directory, ...parts.slice(0, parts.indexOf(component) + 1));
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(f.directory, target);
  const host = new IntegrationHostFactory({ ...f.options, instance: { id: 'synthetic-profile', agentId: 'alpha' } }).forAgent('alpha');
  await expect(host.storage.directory('sessions')).rejects.toThrow('symbolic link');
});

test('legacy defaults use the existing agent-data symlink while retaining provider namespace checks', async () => {
  const f = await fixture();
  const relocated = path.join(f.directory, 'relocated');
  await mkdir(relocated);
  await symlink(relocated, path.join(f.directory, 'agent-data'));
  const host = new IntegrationHostFactory(f.options).forAgent('alpha');
  const sessions = await host.storage.directory('sessions');
  expect(sessions).toBe(path.join(relocated, 'alpha', 'sessions'));
  await writeFile(path.join(sessions, 'synthetic-session'), 'synthetic retained content');
  const restarted = new IntegrationHostFactory(f.options).forAgent('alpha');
  expect(await readFile(path.join(await restarted.storage.directory('sessions'), 'synthetic-session'), 'utf8'))
    .toBe('synthetic retained content');
  await symlink(f.directory, path.join(relocated, 'beta'));
  await expect(new IntegrationHostFactory(f.options).forAgent('beta').storage.directory('sessions'))
    .rejects.toThrow('symbolic link');
});

test('instance storage snapshots its exact identity and rejects traversal before constructing a host', async () => {
  const f = await fixture();
  for (const id of ['../escape', 'synthetic/other', '%2e%2e', '.']) {
    expect(() => new IntegrationHostFactory({ ...f.options, instance: { id, agentId: 'alpha' } })).toThrow();
  }
  const instance = { id: 'synthetic-original', agentId: 'alpha' };
  const factory = new IntegrationHostFactory({ ...f.options, instance });
  instance.id = 'synthetic-replacement';
  expect(factory.forAgent('alpha').storage.rootDirectory).toBe(path.join(f.directory, 'agent-data', 'instances', 'synthetic-original'));
});
