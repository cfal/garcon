import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirectChatRuntimeBase } from '../direct-chat-runtime-base.ts';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-common/shared/native-message-source';

const createdDirs = [];
const runtimes = [];

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-direct-base-runtime-'));
  createdDirs.push(dir);
  return dir;
}

function waitForMessages(runtime) {
  return new Promise((resolve) => {
    runtime.onMessages((_chatId, messages) => resolve(messages));
  });
}

class CapturingDirectRuntime extends DirectChatRuntimeBase {
  captured = [];

  constructor(dir) {
    super({
      runtimeId: 'capturing-direct',
      runtimeLabel: 'Capturing Direct',
      defaultModel: 'default-model',
      fallbackModels: [],
      getSessionDir: () => dir,
      getSessionFilePath: (sessionId) => path.join(dir, `${sessionId}.jsonl`),
    });
    runtimes.push(this);
  }

  buildUserTurn(command) {
    return {
      message: { role: 'user', content: command },
      persistedContent: command,
    };
  }

  buildAssistantMessage(content) {
    return { role: 'assistant', content };
  }

  persistedToMessage(message) {
    return message;
  }

  async streamSession(session) {
    this.captured.push({
      thinkingMode: session.thinkingMode,
      messages: structuredClone(session.messages),
    });
    return 'OK';
  }
}

function startRequest(overrides = {}) {
  return {
    chatId: 'chat-1',
    command: 'first message',
    projectPath: '/tmp/project',
    model: 'selected-model',
    permissionMode: 'default',
    thinkingMode: 'high',
    claudeThinkingMode: 'auto',
    ...overrides,
  };
}

function resumeRequest(agentSessionId, overrides = {}) {
  return {
    chatId: 'chat-1',
    agentSessionId,
    command: 'next message',
    projectPath: '/tmp/project',
    model: 'selected-model',
    permissionMode: 'default',
    thinkingMode: 'low',
    claudeThinkingMode: 'auto',
    ...overrides,
  };
}

describe('DirectChatRuntimeBase reasoning effort lifecycle', () => {
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.shutdown();
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('captures effort before initial provider work', async () => {
    const runtime = new CapturingDirectRuntime(await tempDir());
    const messages = waitForMessages(runtime);

    await runtime.startSession(startRequest({ thinkingMode: 'high' }));
    await messages;

    expect(runtime.captured).toEqual([{
      thinkingMode: 'high',
      messages: [{ role: 'user', content: 'first message' }],
    }]);
  });

  it('emits the persisted assistant turn identity despite timestamp drift', async () => {
    const runtime = new CapturingDirectRuntime(await tempDir());
    const messages = waitForMessages(runtime);

    await runtime.startSession(startRequest({ turnId: 'turn-1' }));
    const emitted = await messages;

    expect(emitted).toHaveLength(1);
    expect(getNativeMessageRevisionSource(emitted[0])).toEqual({
      entryId: 'direct-turn:turn-1',
      withinSourceOrdinal: 1,
    });
  });

  it('replaces effort on every in-memory resume, including Default', async () => {
    const runtime = new CapturingDirectRuntime(await tempDir());
    const firstMessages = waitForMessages(runtime);
    const started = await runtime.startSession(startRequest({ thinkingMode: 'high' }));
    await firstMessages;

    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'second message',
      thinkingMode: 'low',
    }));
    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'third message',
      thinkingMode: 'none',
    }));

    expect(runtime.captured.map((entry) => entry.thinkingMode)).toEqual([
      'high',
      'low',
      'none',
    ]);
    expect(runtime.captured[2].messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'second message' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'third message' },
    ]);
  });

  it('uses the current resume effort when hydrating persisted messages', async () => {
    const dir = await tempDir();
    const sessionId = 'persisted-session';
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ role: 'user', content: 'first message' }),
      JSON.stringify({ role: 'assistant', content: 'first response' }),
      '',
    ].join('\n'));

    const runtime = new CapturingDirectRuntime(dir);
    await runtime.runTurn(resumeRequest(sessionId, {
      command: 'resumed message',
      thinkingMode: 'max',
    }));

    expect(runtime.captured).toEqual([{
      thinkingMode: 'max',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'resumed message' },
      ],
    }]);
  });

  it('normalizes invalid untyped effort to Default', async () => {
    const runtime = new CapturingDirectRuntime(await tempDir());
    const messages = waitForMessages(runtime);

    await runtime.startSession(startRequest({ thinkingMode: 'invalid' }));
    await messages;

    expect(runtime.captured[0].thinkingMode).toBe('none');
  });
});
