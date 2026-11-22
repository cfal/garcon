import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAntigravityConfig } from '../../../config.js';
import { createAntigravityAccount } from '../antigravity-account.js';

it.skipIf(process.platform !== 'linux')('fences unfinished model and headless auth probes across a successful login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-login-'));
  const binary = join(root, 'agy');
  await writeFile(binary, `#!/bin/sh
cd "$(dirname "$0")" || exit 1
case "$1" in
  models)
    if test -f signed-in; then printf 'new-model\\tNew Model\\n'; else
      touch models-started
      while ! test -f release; do sleep 0.01; done
    fi ;;
  acp)
    if test "$2" = --login; then
      printf 'https://example.test/login\\n'
      read -r code && test "$code" = synthetic-code && touch signed-in
    else
      read -r init && echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
      read -r auth
      if test -f signed-in; then
        echo '{"jsonrpc":"2.0","id":2,"result":{}}'
        read -r initialized
      else
        touch auth-started
        while ! test -f release; do sleep 0.01; done
        echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Signed out"}}'
      fi
    fi ;;
esac
`, { mode: 0o700 });
  const config = createAntigravityConfig({ get: (name) => name === 'GARCON_ANTIGRAVITY_BINARY' ? binary : undefined });
  const account = createAntigravityAccount(config, { debug() {}, info() {}, warn() {}, error() {} });
  const signal = AbortSignal.timeout(3000);
  const snapshot = () => account.catalog.snapshot({ strict: false, signal });
  const before = account.catalog.snapshot({ strict: false, signal: new AbortController().signal });
  const oldAuth = account.auth.status(new AbortController().signal);
  try {
    for (const marker of ['models-started', 'auth-started']) {
      while (!await Bun.file(join(root, marker)).exists()) { signal.throwIfAborted(); await Bun.sleep(5); }
    }
    const { sessionId } = await account.auth.launchLogin();
    await account.auth.completeLogin(sessionId, 'synthetic-code');
    while ((await account.auth.loginStatus(sessionId)).state === 'running') { signal.throwIfAborted(); await Bun.sleep(5); }
    expect((await account.auth.loginStatus(sessionId)).state).toBe('succeeded');
    expect((await snapshot()).models.map(model => model.value)).toEqual(['default', 'new-model']);
    expect((await account.auth.status(signal)).authenticated).toBe(true);
    await writeFile(join(root, 'release'), '');
    expect((await oldAuth).authenticated).toBe(false);
    // A second pending login uses the last confirmed auth status, not the old probe.
    await account.auth.launchLogin();
    expect((await account.auth.status(signal)).authenticated).toBe(true);
  } finally {
    await writeFile(join(root, 'release'), '');
    account.stop();
    await Promise.allSettled([before, oldAuth]);
    await rm(root, { recursive: true, force: true });
  }
});
