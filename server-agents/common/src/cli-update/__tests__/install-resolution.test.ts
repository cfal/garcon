import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import {
  homebrewKegFromCommandPath,
  npmGlobalPrefixFromCommandPath,
  resolveCliInstallation,
  type CliInstallDefinition,
} from '../install-resolution.js';
import { createCliUpdateFixture, type CliUpdateFixture } from './cli-update-fixture.js';

const PACKAGE = '@anthropic-ai/claude-code';
const DEFINITION: CliInstallDefinition = {
  packageName: PACKAGE,
  native: {
    ownsCommandPath: (normalized) => normalized.includes('/.local/share/claude/'),
    args: ['update'],
    env: (paths) => ({ SYNTHETIC_NATIVE_REAL: paths.real }),
  },
};

let fixture: CliUpdateFixture;
beforeEach(async () => { fixture = await createCliUpdateFixture(); });
afterEach(async () => { await fixture.dispose(); });

function resolve(command: string, platform: NodeJS.Platform = 'linux') {
  return resolveCliInstallation(DEFINITION, { command, env: fixture.env, platform });
}

test('reports a command that is not on PATH as missing', async () => {
  expect(await resolve('synthetic-missing-cli')).toMatchObject({ method: 'missing', paths: null, update: null });
});

test('updates a native install through its own launcher', async () => {
  const real = path.join(fixture.root, '.local', 'share', 'claude', 'versions', '2.1.238');
  await fixture.writeScript(real, 'echo 2.1.238');
  const launcher = path.join(fixture.root, '.local', 'bin', 'claude');
  await mkdir(path.dirname(launcher), { recursive: true });
  await symlink(real, launcher);
  const installation = await resolve(launcher);
  expect(installation).toMatchObject({
    method: 'native',
    paths: { resolved: launcher, real },
    latestVersion: { kind: 'native' },
    update: { executable: launcher, args: ['update'], env: { SYNTHETIC_NATIVE_REAL: real }, command: `${launcher} update` },
  });
});

test('updates an npm global install in its own prefix', async () => {
  await fixture.writeScript(path.join(fixture.bin, 'npm'), 'exit 0');
  const cli = await fixture.installNpmCli({ name: 'claude', packageName: PACKAGE, version: '2.1.238' });
  const installation = await resolve(cli.launcher);
  expect(installation.method).toBe('npm');
  expect(installation.update).toEqual({
    executable: path.join(fixture.bin, 'npm'),
    args: ['install', '-g', '--prefix', cli.prefix, `--allow-scripts=${PACKAGE}`, `${PACKAGE}@latest`],
    env: {},
    lockKey: `npm-global:${cli.prefix.toLowerCase()}`,
    command: `npm install -g --prefix ${cli.prefix} --allow-scripts=${PACKAGE} ${PACKAGE}@latest`,
  });
});

test('offers the npm command for manual use when npm is not on PATH', async () => {
  const cli = await fixture.installNpmCli({ name: 'claude', packageName: PACKAGE, version: '2.1.238' });
  const installation = await resolve(cli.launcher);
  expect(installation).toMatchObject({ method: 'npm', update: null });
  expect(installation.manualCommand).toStartWith('npm install -g --prefix ');
});

test('prefers npm ownership over a native-looking launcher', async () => {
  await fixture.writeScript(path.join(fixture.bin, 'npm'), 'exit 0');
  const cli = await fixture.installNpmCli({ name: 'claude', packageName: PACKAGE, version: '2.1.238' });
  const launcher = path.join(fixture.root, '.local', 'share', 'claude', 'claude');
  await mkdir(path.dirname(launcher), { recursive: true });
  await symlink(cli.real, launcher);
  expect((await resolve(launcher)).method).toBe('npm');
});

test('updates bun globals and approves pnpm builds on pnpm 10.4 or newer', async () => {
  await fixture.writeScript(path.join(fixture.bin, 'bun'), 'exit 0');
  await fixture.writeScript(path.join(fixture.bin, 'pnpm'), 'echo 10.4.1');
  const bunCli = path.join(fixture.root, '.bun', 'bin', 'claude');
  await fixture.writeScript(bunCli, 'echo 2.1.238');
  expect((await resolve(bunCli)).update).toMatchObject({
    args: ['i', '-g', `${PACKAGE}@latest`], lockKey: 'bun-global', command: `bun i -g ${PACKAGE}@latest`,
  });
  const pnpmCli = path.join(fixture.root, '.local', 'share', 'pnpm', 'claude');
  await fixture.writeScript(pnpmCli, 'echo 2.1.238');
  expect((await resolve(pnpmCli)).update).toMatchObject({
    args: ['add', '-g', `--allow-build=${PACKAGE}`, `${PACKAGE}@latest`], lockKey: 'pnpm-global',
  });
});

test('upgrades a Homebrew keg with the keg prefix brew', async () => {
  const brew = path.join(fixture.root, 'homebrew', 'bin', 'brew');
  await fixture.writeScript(brew, 'exit 0');
  const keg = path.join(fixture.root, 'homebrew', 'Caskroom', 'claude-code', '2.1.238', 'claude');
  await fixture.writeScript(keg, 'echo 2.1.238');
  const installation = await resolve(keg);
  expect(installation).toMatchObject({
    method: 'homebrew',
    update: { executable: brew, args: ['upgrade', '--cask', 'claude-code'], command: 'brew upgrade --cask claude-code' },
    latestVersion: { kind: 'homebrew', brew, name: 'claude-code', cask: true },
  });
});

test('leaves mise installs and unrecognized locations to the user', async () => {
  const mise = path.join(fixture.root, '.local', 'share', 'mise', 'installs', 'claude', '2.1.238', 'bin', 'claude');
  await fixture.writeScript(mise, 'echo 2.1.238');
  expect(await resolve(mise)).toMatchObject({ method: 'unmanaged', update: null, manualCommand: null });
  const other = path.join(fixture.root, 'opt', 'claude');
  await fixture.writeScript(other, 'echo 2.1.238');
  expect(await resolve(other)).toMatchObject({ method: 'unmanaged', update: null });
});

test('quotes display commands for the platform shell', async () => {
  const real = path.join(fixture.root, '.local', 'share', 'claude', "it's here", 'claude');
  await fixture.writeScript(real, 'echo 2.1.238');
  expect((await resolve(real)).update?.command).toBe(`'${real.replace("'", "'\\''")}' update`);
  expect((await resolve(real, 'win32')).update?.command).toBe(`& '${real.replace("'", "''")}' update`);
});

test('proves npm prefixes and Homebrew kegs from real paths', () => {
  expect(npmGlobalPrefixFromCommandPath('/usr/local/lib/node_modules/@openai/codex/bin/codex.js', '@openai/codex')).toBe('/usr/local');
  expect(npmGlobalPrefixFromCommandPath('/repo/node_modules/x/lib/node_modules/@openai/codex/bin/codex.js', '@openai/codex')).toBeNull();
  expect(npmGlobalPrefixFromCommandPath('/home/u/.local/share/mise/installs/codex/1.0.0/lib/node_modules/@openai/codex/bin/codex.js', '@openai/codex')).toBeNull();
  expect(npmGlobalPrefixFromCommandPath('/home/u/.local/share/mise/installs/node/22.0.0/lib/node_modules/@openai/codex/bin/codex.js', '@openai/codex'))
    .toBe('/home/u/.local/share/mise/installs/node/22.0.0');
  expect(homebrewKegFromCommandPath('/opt/homebrew/Cellar/codex/0.169.0/bin/codex')).toEqual({ prefix: '/opt/homebrew', name: 'codex', cask: false });
  expect(homebrewKegFromCommandPath('/usr/local/bin/codex')).toBeNull();
});
