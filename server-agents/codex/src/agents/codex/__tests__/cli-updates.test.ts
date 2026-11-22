import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtempDisposable, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexConfig } from '../../../config.js';
import { codexStandaloneHome, createCodexCliUpdates, parseCodexChannelRelease } from '../cli-updates.js';

test('finds the CODEX_HOME that owns a standalone install', () => {
  expect(codexStandaloneHome('/home/u/.codex/packages/standalone/0.170.0/bin/codex')).toBe('/home/u/.codex');
  expect(codexStandaloneHome('C:\\Users\\u\\.codex\\packages\\standalone\\0.170.0\\codex.exe')).toBe('C:\\Users\\u\\.codex');
  expect(codexStandaloneHome('/packages/standalone/codex')).toBe('/');
  expect(codexStandaloneHome('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toBeNull();
});

test('reads the native channel release tag', () => {
  expect(parseCodexChannelRelease('{"tag_name":"rust-v0.170.0"}')).toBe('0.170.0');
  expect(parseCodexChannelRelease('{"tag_name":"v0.170.0"}')).toBeNull();
  expect(parseCodexChannelRelease('<html>')).toBeNull();
});

test.skipIf(process.platform === 'win32')('updates the selected standalone Codex using its install home and release channel', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'codex-update-'));
  const home = await realpath(directory.path);
  const bin = join(home, 'packages/standalone/bin');
  const command = join(bin, 'codex');
  const launcher = join(home, 'codex');
  const versionFile = join(home, 'VERSION');
  await mkdir(bin, { recursive: true });
  await writeFile(versionFile, '0.171.0');
  await writeFile(command, `#!/bin/sh
case "$1" in
  --version) cat ${JSON.stringify(versionFile)} ;;
  update) echo 0.172.0 > "$CODEX_HOME/VERSION" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  await symlink(command, launcher);
  using channel = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async () => Response.json({ tag_name: 'rust-v0.172.0' }), { preconnect() {} },
  ));
  const previous = process.env.GARCON_CODEX_CLI;
  process.env.GARCON_CODEX_CLI = launcher;
  try {
    const updates = createCodexCliUpdates({
      config: createCodexConfig({ get: (name) => name === 'CODEX_HOME' ? join(home, 'sessions') : undefined }),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const request = { refresh: false, signal: AbortSignal.timeout(4_000) };
    expect(await updates.status(request)).toMatchObject({
      installMethod: 'native', installPath: command, currentVersion: '0.171.0', latestVersion: '0.172.0', canUpdate: true,
    });
    expect(channel.mock.calls[0]?.[0]).toBe('https://releases.openai.com/codex/channels/latest');
    let status = await updates.startUpdate();
    while (status.run.state === 'running') {
      request.signal.throwIfAborted();
      await Bun.sleep(10);
      status = await updates.status(request);
    }
    expect(status).toMatchObject({ currentVersion: '0.172.0', advisory: 'current', run: { state: 'succeeded' } });
  } finally {
    if (previous === undefined) delete process.env.GARCON_CODEX_CLI;
    else process.env.GARCON_CODEX_CLI = previous;
  }
});
