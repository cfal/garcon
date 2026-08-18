import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationDirectories } from '../../support/integration-fixture.js';
import {
  waitForPersistedChat,
  waitForPersistedNativeSession,
} from '../../support/persisted-chat.js';

describe('persisted chat polling', () => {
  let directories: IntegrationDirectories;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-persisted-chat-support-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    directories = {
      root,
      workspace,
      config: join(root, 'config'),
      project: join(root, 'project'),
      home: join(root, 'home'),
    };
  });

  afterEach(async () => {
    await rm(directories.root, { recursive: true, force: true });
  });

  it('retries ENOENT until an atomic registry snapshot appears', async () => {
    const result = waitForReadyChat(directories, 'chat-1');
    let settled = false;
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Bun.sleep(40);
    expect(settled).toBe(false);

    await writeRegistryAtomic(directories.workspace, {
      sessions: { 'chat-1': persistedChat({ ready: true }) },
    });

    await expect(result).resolves.toBe('session-1');
  });

  it('retries a valid registry until the chat appears', async () => {
    await writeRegistryAtomic(directories.workspace, { sessions: {} });
    const result = waitForReadyChat(directories, 'chat-1');
    let settled = false;
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Bun.sleep(40);
    expect(settled).toBe(false);

    await writeRegistryAtomic(directories.workspace, {
      sessions: { 'chat-1': persistedChat({ ready: true }) },
    });

    await expect(result).resolves.toBe('session-1');
  });

  it('retries while the selector reports a valid chat as not ready', async () => {
    await writeRegistryAtomic(directories.workspace, {
      sessions: { 'chat-1': persistedChat({ ready: false }) },
    });
    const result = waitForReadyChat(directories, 'chat-1');
    let settled = false;
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Bun.sleep(40);
    expect(settled).toBe(false);

    await writeRegistryAtomic(directories.workspace, {
      sessions: { 'chat-1': persistedChat({ ready: true }) },
    });

    await expect(result).resolves.toBe('session-1');
  });

  it('propagates malformed JSON and registry shapes', async () => {
    const registryPath = join(directories.workspace, 'chats.json');
    await writeFile(registryPath, '{', 'utf8');
    await expect(waitForReadyChat(directories, 'chat-1')).rejects.toBeInstanceOf(SyntaxError);

    await writeFile(registryPath, JSON.stringify({ sessions: [] }), 'utf8');
    await expect(waitForReadyChat(directories, 'chat-1')).rejects.toThrow(
      'Persisted chat registry is invalid.',
    );

    await writeFile(registryPath, JSON.stringify({ sessions: { 'chat-1': 'invalid' } }), 'utf8');
    await expect(waitForReadyChat(directories, 'chat-1')).rejects.toThrow(
      'Persisted chat chat-1 is invalid.',
    );
  });

  it('propagates an agent mismatch without polling to the deadline', async () => {
    await writeRegistryAtomic(directories.workspace, {
      sessions: { 'chat-1': persistedChat({ agentId: 'pi', ready: true }) },
    });

    await expect(waitForPersistedNativeSession({
      directories,
      chatId: 'chat-1',
      agentId: 'claude',
      timeoutMs: 1_000,
    })).rejects.toThrow('Chat chat-1 is not a claude chat.');
  });

  it('propagates selector exceptions without polling to the deadline', async () => {
    await writeRegistryAtomic(directories.workspace, {
      sessions: { 'chat-1': persistedChat({ ready: true }) },
    });
    const failure = new Error('selector failed');

    await expect(waitForPersistedChat({
      directories,
      chatId: 'chat-1',
      timeoutMs: 1_000,
      timeoutMessage: 'unexpected polling timeout',
      select: () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it('propagates non-ENOENT read failures without polling to the deadline', async () => {
    await mkdir(join(directories.workspace, 'chats.json'));

    await expect(waitForReadyChat(directories, 'chat-1')).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});

function waitForReadyChat(
  directories: IntegrationDirectories,
  chatId: string,
): Promise<string> {
  return waitForPersistedChat({
    directories,
    chatId,
    timeoutMs: 1_000,
    timeoutMessage: `Chat ${chatId} did not become ready.`,
    select: (chat) => chat.ready === true ? chat.agentSessionId : null,
  });
}

function persistedChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'claude',
    agentSessionId: 'session-1',
    modelEndpointId: null,
    nativeSession: { value: {} },
    ...overrides,
  };
}

async function writeRegistryAtomic(workspace: string, registry: unknown): Promise<void> {
  const registryPath = join(workspace, 'chats.json');
  const temporaryPath = join(workspace, 'chats.json.tmp');
  await writeFile(temporaryPath, JSON.stringify(registry), 'utf8');
  await rename(temporaryPath, registryPath);
}
