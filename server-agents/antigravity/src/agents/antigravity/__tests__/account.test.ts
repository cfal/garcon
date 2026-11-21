import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAntigravityConfig } from '../../../config.js';
import { createAntigravityAccount } from '../antigravity-account.js';

it('does not share an unfinished pre-login model probe with a caller after successful login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-login-'));
  const binary = join(root, 'agy');
  await writeFile(binary, `#!/bin/sh
cd "$(dirname "$0")" || exit 1
case "$1" in
  models)
    if test -f signed-in; then printf 'new-model\\tNew Model\\n'; else
      touch started
      while ! test -f release; do sleep 0.01; done
    fi ;;
  acp)
    printf 'https://example.test/login\\n'
    read -r code && test "$code" = synthetic-code && touch signed-in ;;
esac
`, { mode: 0o700 });
  const config = createAntigravityConfig({ get: (name) => name === 'GARCON_ANTIGRAVITY_BINARY' ? binary : undefined });
  const account = createAntigravityAccount(config, { debug() {}, info() {}, warn() {}, error() {} });
  const signal = AbortSignal.timeout(3000);
  const snapshot = () => account.catalog.snapshot({ strict: false, signal });
  const before = account.catalog.snapshot({ strict: false, signal: new AbortController().signal });
  try {
    while (!await Bun.file(join(root, 'started')).exists()) { signal.throwIfAborted(); await Bun.sleep(5); }
    const { sessionId } = await account.auth.launchLogin();
    await account.auth.completeLogin(sessionId, 'synthetic-code');
    while ((await account.auth.loginStatus(sessionId)).state === 'running') { signal.throwIfAborted(); await Bun.sleep(5); }
    expect((await account.auth.loginStatus(sessionId)).state).toBe('succeeded');
    expect((await snapshot()).models.map(model => model.value)).toEqual(['default', 'new-model']);
  } finally {
    await writeFile(join(root, 'release'), '');
    account.stop();
    await before.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
