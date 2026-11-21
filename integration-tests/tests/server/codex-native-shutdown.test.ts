import { describe, expect, it } from 'bun:test';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../../../server-agents/codex/src/agents/codex/app-server/client.js';
import { CODEX_BINARY } from '../../support/live-codex.js';

describe('pinned Codex shutdown compatibility', () => {
  it('waits for the native app-server to exit after terminating slow cleanup', async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), 'garcon-codex-shutdown-'));
    const codexHome = directory.path;
    const hookPath = path.join(codexHome, 'session-end.sh');
    const hookStartedPath = path.join(codexHome, 'hook-started');
    await writeFile(hookPath, `#!/bin/sh\nprintf started > ${JSON.stringify(hookStartedPath)}\nsleep 8\n`, { mode: 0o700 });
    await writeFile(path.join(codexHome, 'config.toml'), [
      'model = "mock-model"',
      'model_provider = "mock"',
      '[model_providers.mock]',
      'name = "mock"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      '[features]',
      'hooks = true',
      // Prevents background marketplace fetches from outliving the fixture.
      // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core-plugins/src/manager.rs#L2824-L2834
      'plugins = false',
      '[[hooks.SessionEnd]]',
      'matcher = "other"',
      '[[hooks.SessionEnd.hooks]]',
      'type = "command"',
      `command = ${JSON.stringify(hookPath)}`,
      'timeout = 15',
      '',
    ].join('\n'));

    const client = new CodexAppServerClient({
      env: { GARCON_CODEX_CLI: CODEX_BINARY, CODEX_HOME: codexHome, HOME: codexHome },
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
