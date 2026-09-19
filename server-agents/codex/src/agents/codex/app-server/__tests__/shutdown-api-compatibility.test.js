import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../client.ts';

const temporaryHomes = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('bundled Codex shutdown compatibility', () => {
  it('waits for the native app-server to exit after terminating slow cleanup', async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), 'garcon-codex-shutdown-'));
    temporaryHomes.push(codexHome);
    const hookPath = path.join(codexHome, 'session-end.sh');
    const hookStartedPath = path.join(codexHome, 'hook-started');
    await writeFile(hookPath, `#!/bin/sh\nprintf started > ${JSON.stringify(hookStartedPath)}\nsleep 8\n`);
    await chmod(hookPath, 0o700);
    await writeFile(path.join(codexHome, 'config.toml'), [
      'model = "mock-model"',
      'model_provider = "mock"',
      '[model_providers.mock]',
      'name = "mock"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      '[features]',
      'hooks = true',
      '[[hooks.SessionEnd]]',
      'matcher = "other"',
      '[[hooks.SessionEnd.hooks]]',
      'type = "command"',
      `command = ${JSON.stringify(hookPath)}`,
      'timeout = 15',
      '',
    ].join('\n'));

    const client = new CodexAppServerClient({
      env: { CODEX_HOME: codexHome, HOME: codexHome },
      shutdownGraceMs: 2_000,
    });
    let exitObserved = false;
    client.on('exit', () => { exitObserved = true; });

    try {
      await client.connect();
      await client.startThread({
        model: 'mock-model',
        cwd: codexHome,
        approvalPolicy: 'never',
        historyMode: 'paginated',
        config: { bypass_hook_trust: true },
      });
      await client.shutdown();
    } finally {
      await client.shutdown();
    }

    expect(await Bun.file(hookStartedPath).exists()).toBe(true);
    expect(exitObserved).toBe(true);
  }, 15_000);
});
