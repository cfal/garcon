import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { DirectChatRuntimeBase } from '../direct-chat-runtime-base.ts';

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

  contextMessage(message) {
    if (message.type === 'user-message') return { role: 'user', content: message.content };
    if (message.type === 'assistant-message') return { role: 'assistant', content: message.content };
    return null;
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

  it('replaces effort on every in-memory resume, including Default', async () => {
    const runtime = new CapturingDirectRuntime(await tempDir());
    const firstMessages = waitForMessages(runtime);
    const started = await runtime.startSession(startRequest({ thinkingMode: 'high' }));
    await firstMessages;

    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'second message',
      thinkingMode: 'low',
      priorContext: [
        new UserMessage('2026-01-01T00:00:00.000Z', 'first message'),
        new AssistantMessage('2026-01-01T00:00:01.000Z', 'OK'),
      ],
    }));
    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'third message',
      thinkingMode: 'none',
      priorContext: [
        new UserMessage('2026-01-01T00:00:00.000Z', 'first message'),
        new AssistantMessage('2026-01-01T00:00:01.000Z', 'OK'),
        new UserMessage('2026-01-01T00:00:02.000Z', 'second message'),
        new AssistantMessage('2026-01-01T00:00:03.000Z', 'OK'),
      ],
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

  it('uses the current resume effort with supplied ledger context', async () => {
    const dir = await tempDir();
    const sessionId = 'persisted-session';

    const runtime = new CapturingDirectRuntime(dir);
    await runtime.runTurn(resumeRequest(sessionId, {
      command: 'resumed message',
      thinkingMode: 'max',
      priorContext: [
        new UserMessage('2026-01-01T00:00:00.000Z', 'first message'),
        new AssistantMessage('2026-01-01T00:00:01.000Z', 'first response'),
      ],
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
