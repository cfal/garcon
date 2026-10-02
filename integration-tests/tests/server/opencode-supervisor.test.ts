import { expect, test } from 'bun:test';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PINNED_OPENCODE_VERSION,
  processIdentityAlive,
  readJsonFile,
  writeJsonAtomic,
  type OpenCodeProcessState,
} from '../../support/opencode-process-supervisor.js';

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the OpenCode supervisor.');
}

test('stops the provider before shutdown diagnostics can block supervisor exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'garcon-opencode-shutdown-write-'));
  const binary = join(root, 'provider');
  const verification = join(root, 'verification.json');
  const writeHeld = join(root, 'write-held');
  await writeFile(binary, '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
  await writeJsonAtomic(verification, { binary, version: PINNED_OPENCODE_VERSION });
  const supervisor = Bun.spawn([
    process.execPath,
    '--preload',
    fileURLToPath(new URL('../../support/hold-opencode-shutdown-write.ts', import.meta.url)),
    fileURLToPath(new URL('../../support/opencode-process-supervisor.ts', import.meta.url)),
  ], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GARCON_TEST_OPENCODE_REAL_BINARY: binary,
      GARCON_TEST_OPENCODE_VERIFICATION: verification,
      GARCON_TEST_OPENCODE_PROCESS_STATE: root,
      GARCON_TEST_OPENCODE_WRITE_HELD: writeHeld,
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = new Response(supervisor.stderr).text();
  let record: OpenCodeProcessState | null = null;
  try {
    record = await waitFor(async () => {
      const entry = (await readdir(root)).find((name) => /^wrapper-.*\.json$/.test(name));
      if (!entry) return null;
      const snapshot = await readJsonFile<OpenCodeProcessState>(join(root, entry));
      return snapshot?.providerProcessGroupId ? snapshot : null;
    });
    expect(processIdentityAlive(record.providerPid, record.providerStartTimeTicks)).toBe(true);
    supervisor.kill('SIGTERM');
    await waitFor(async () => await access(writeHeld).then(() => true, () => null));
    // Models Garcon's escalation while the diagnostics write remains held.
    supervisor.kill('SIGKILL');
    await supervisor.exited;
    expect(processIdentityAlive(record.providerPid, record.providerStartTimeTicks)).toBe(false);
    expect(await stderr).toBe('');
  } finally {
    supervisor.kill('SIGKILL');
    await supervisor.exited;
    if (record && processIdentityAlive(record.providerPid, record.providerStartTimeTicks)) {
      process.kill(record.providerPid, 'SIGKILL');
      await waitFor(async () => processIdentityAlive(record!.providerPid, record!.providerStartTimeTicks) ? null : true);
    }
    await stderr;
    await rm(root, { recursive: true, force: true });
  }
});
