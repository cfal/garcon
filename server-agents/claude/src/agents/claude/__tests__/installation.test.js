import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeConfig } from '../../../config.js';
import { ClaudeInstallation } from '../installation.js';
import { ClaudeCliVersionProbe } from '../cli-version.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(mode = 'success', version = '2.1.207', timeoutMs) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-installation-'));
  directories.push(directory);
  const binary = join(directory, 'claude executable');
  await writeFile(join(directory, 'version'), version);
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const file = (name) => join(import.meta.dir, name);
const command = process.argv[2];
if (command === '--version') {
  console.log(readFileSync(file('version'), 'utf8') + ' (Claude Code)');
} else if (command === 'update') {
  appendFileSync(file('updates'), 'update\\n');
  writeFileSync(file('environment'), JSON.stringify({ config: process.env.CLAUDE_CONFIG_DIR, nested: process.env.CLAUDECODE }));
  const mode = ${JSON.stringify(mode)};
  if (mode === 'delay') await Bun.sleep(75);
  if (mode === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
  if (mode === 'large') console.log('x'.repeat(100000));
  if (mode === 'success' || mode === 'delay' || mode === 'change-fail') writeFileSync(file('version'), '2.1.285');
  if (mode === 'fail' || mode === 'change-fail') { console.error('Use your package manager: permission denied'); process.exit(1); }
  if (mode === 'stdout-fail' || mode === 'both-fail' || mode === 'ansi-success') {
    console.log('\\x1b[32mRun brew upgrade claude-code\\x1b[0m');
    if (mode !== 'stdout-fail') console.error('\\x1b[31mSynthetic package-manager guidance\\x1b[0m');
    if (mode !== 'ansi-success') process.exit(1);
  }
  console.log(mode === 'noop' ? 'Run brew upgrade claude-code' : 'Update complete');
} else { console.error('unexpected command'); process.exit(2); }
`, { mode: 0o755 });
  const config = createClaudeConfig({ get: (key) => ({ CLAUDE_BINARY: binary, CLAUDE_CONFIG_DIR: directory })[key] });
  const probe = new ClaudeCliVersionProbe();
  return { directory, binary, probe, installation: new ClaudeInstallation(config, probe, timeoutMs) };
}

describe('Claude installation maintenance', () => {
  it('reports an unsupported installed version without blocking maintenance', async () => {
    const { installation } = await fixture();
    await expect(installation.status()).resolves.toEqual({ version: '2.1.207', minimumVersion: '2.1.238', supported: false });
  });

  it('updates the configured executable and clears cached execution rejection', async () => {
    const { binary, directory, probe, installation } = await fixture();
    await expect(probe.assertCompatible(binary)).rejects.toThrow('unsupported');
    const result = await installation.update();
    expect(result.installation).toEqual({ version: '2.1.285', minimumVersion: '2.1.238', supported: true });
    await expect(probe.assertCompatible(binary)).resolves.toEqual([2, 1, 285]);
    expect(JSON.parse(await readFile(join(directory, 'environment'), 'utf8'))).toEqual({ config: directory });
    expect(await readFile(join(directory, 'updates'), 'utf8')).toBe('update\n');
  });

  it('shares a single updater between concurrent requests', async () => {
    const { directory, installation } = await fixture('delay');
    const [first, second] = await Promise.all([installation.update(), installation.update()]);
    expect(first).toEqual(second);
    expect(await readFile(join(directory, 'updates'), 'utf8')).toBe('update\n');
  });

  it('retains unsupported status and actionable output after a package-manager no-op', async () => {
    const { installation } = await fixture('noop');
    const result = await installation.update();
    expect(result.installation.supported).toBe(false);
    expect(result.installation.version).toBe('2.1.207');
    expect(result.output).toContain('brew upgrade claude-code');
  });

  it('reports an already supported installation without inventing a version change', async () => {
    const { installation } = await fixture('noop', '2.1.285');
    expect((await installation.update()).installation).toMatchObject({ version: '2.1.285', supported: true });
  });

  it('preserves updater errors and releases the lock for retry', async () => {
    const { directory, installation } = await fixture('fail');
    await expect(installation.update()).rejects.toThrow('permission denied');
    await expect(installation.update()).rejects.toThrow('permission denied');
    expect((await readFile(join(directory, 'updates'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it.each(['stdout-fail', 'both-fail'])('preserves sanitized output from %s', async (mode) => {
    const { installation } = await fixture(mode);
    const failure = await installation.update().catch((error) => error);
    expect(failure.code).toBe('PROVIDER_FAILURE');
    expect(failure.message).toContain('Run brew upgrade claude-code');
    expect(failure.message).not.toContain('\x1b');
    expect(failure.message).not.toContain('Command failed');
    if (mode === 'both-fail') expect(failure.message).toContain('Synthetic package-manager guidance');
  });

  it('uses the same sanitizer for successful stdout and stderr', async () => {
    const { installation } = await fixture('ansi-success');
    const result = await installation.update();
    expect(result.output).toContain('Run brew upgrade claude-code');
    expect(result.output).toContain('Synthetic package-manager guidance');
    expect(result.output).not.toContain('\x1b');
  });

  it('invalidates the cache even when an update changes the launcher and then fails', async () => {
    const { binary, probe, installation } = await fixture('change-fail');
    await expect(probe.assertCompatible(binary)).rejects.toThrow('unsupported');
    await expect(installation.update()).rejects.toThrow('permission denied');
    await expect(probe.assertCompatible(binary)).resolves.toEqual([2, 1, 285]);
  });

  it('bounds updater output and rejects a missing configured executable', async () => {
    const { directory, installation } = await fixture('large');
    await expect(installation.update()).rejects.toBeInstanceOf(Error);
    const missing = new ClaudeInstallation(createClaudeConfig({ get: (key) => key === 'CLAUDE_BINARY' ? join(directory, 'missing') : undefined }), new ClaudeCliVersionProbe());
    await expect(missing.update()).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' });
  });

  it('does not run an update after caller cancellation', async () => {
    const { directory, installation } = await fixture();
    const signal = AbortSignal.abort(new Error('cancelled'));
    expect(() => installation.update({ signal })).toThrow('cancelled');
    expect(await Bun.file(join(directory, 'updates')).exists()).toBe(false);
  });

  it('bounds a hung updater and releases its lock for retry', async () => {
    const { binary, directory, installation, probe } = await fixture('hang', '2.1.207', 1000);
    await expect(probe.assertCompatible(binary)).rejects.toThrow('unsupported');
    await expect(installation.update()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await writeFile(join(directory, 'version'), '2.1.285');
    await expect(probe.assertCompatible(binary)).resolves.toEqual([2, 1, 285]);
    await expect(installation.update()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect((await readFile(join(directory, 'updates'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('cancels only its updater process and settles concurrent waiters before retry', async () => {
    const { directory, installation } = await fixture('hang');
    const controller = new AbortController();
    const first = installation.update({ signal: controller.signal });
    const joined = installation.update();
    while (!await Bun.file(join(directory, 'updates')).exists()) await Bun.sleep(5);
    controller.abort(new Error('Synthetic cancellation'));
    const results = await Promise.allSettled([first, joined]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(installation.status()).resolves.toMatchObject({ version: '2.1.207' });
    expect(await readFile(join(directory, 'updates'), 'utf8')).toBe('update\n');
  });
});
