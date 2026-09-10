import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatRegistry, CHAT_REGISTRY_VERSION } from '../../server/chats/store.js';
import { ExecutionNodesStore } from '../../server/execution-nodes/store.js';
import { seedSmokeAccount, seedSmokeTranscript, SMOKE_CHAT_ID, SMOKE_SEARCH_TOKEN } from '../smoke-exe-fixture.js';

test('compiled smoke configures a private account before exposing its listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-smoke-account-'));
  try {
    const account = await seedSmokeAccount(directory);
    const file = join(directory, 'auth.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.username).toBe(account.username);
    expect(await Bun.password.verify(account.password, stored.passwordHash)).toBe(true);
    expect(await readFile(file, 'utf8')).not.toContain(account.password);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compiled search fixture uses the current registry and a real persisted local execution target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-smoke-fixture-'));
  try {
    await seedSmokeTranscript(directory);
    const registry = new ChatRegistry(directory);
    const snapshot = await registry.init();
    expect(snapshot.version).toBe(CHAT_REGISTRY_VERSION);
    const chat = registry.getChat(SMOKE_CHAT_ID);
    const nodes = new ExecutionNodesStore(directory);
    await nodes.init();
    expect(() => nodes.requireLocation(chat.executionLocation, chat.agentId)).not.toThrow();
    expect(chat.projectPath).toBe(directory);
    expect(chat.agentSessionId).toBe('smoke-session');
    const native = JSON.parse(await readFile(chat.nativeSession.value.path, 'utf8'));
    expect(native.message).toEqual({ role: 'user', content: SMOKE_SEARCH_TOKEN });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
