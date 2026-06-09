import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AgentOrchestrator } from '../agent-orchestrator.ts';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-agent-orchestrator-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function createHarness(overrides = {}) {
  const sessions = new Map(Object.entries({
    parent: {
      agentId: 'codex',
      agentSessionId: 'thread-parent',
      nativePath: '/tmp/thread-parent.jsonl',
      projectPath: '/repo',
      model: 'gpt-5.4-codex',
      permissionMode: 'default',
      thinkingMode: 'think',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
      tags: ['codex'],
    },
    ...(overrides.sessions ?? {}),
  }));
  const registry = {
    getChat: mock((chatId) => sessions.get(chatId) ?? null),
    addChat: mock((entry) => {
      if (sessions.has(entry.id)) return false;
      sessions.set(entry.id, { ...entry });
      return true;
    }),
    updateChat: mock((chatId, patch) => {
      const current = sessions.get(chatId);
      if (!current) return null;
      const next = { ...current, ...patch };
      sessions.set(chatId, next);
      return { id: chatId, ...next };
    }),
  };
  const settings = {
    ensureInNormal: mock(() => Promise.resolve()),
    setSessionName: mock(() => Promise.resolve()),
    getChatName: mock(() => null),
  };
  const metadata = {
    addNewChatMetadata: mock(),
    getChatMetadata: mock(() => ({ firstMessage: 'Parent prompt' })),
  };
  const queue = {
    submit: mock(() => Promise.resolve()),
    abort: mock(() => Promise.resolve(true)),
  };
  const agents = {
    supportsFork: mock((agentId) => agentId === 'codex'),
    isAgentSessionRunning: mock(() => false),
  };
  const forkAgentSession = mock(() => Promise.resolve({ agentSessionId: 'child-thread', nativePath: '/tmp/child.jsonl' }));
  const forkChatFileCopy = mock(async ({ targetChatId, sourceSession, threadSource }) => {
    expect(threadSource).toBe('subagent');
    sessions.set(targetChatId, {
      ...sourceSession,
      agentSessionId: `thread-${targetChatId}`,
      nativePath: `/tmp/${targetChatId}.jsonl`,
    });
    return {
      chatId: targetChatId,
      agentId: sourceSession.agentId,
      agentSessionId: `thread-${targetChatId}`,
      nativePath: `/tmp/${targetChatId}.jsonl`,
    };
  });
  const orchestrator = new AgentOrchestrator({
    workspaceDir: tmpDir,
    registry,
    settings,
    metadata,
    queue,
    agents,
    forkChatFileCopy,
    forkAgentSession,
  });
  return { orchestrator, sessions, registry, settings, metadata, queue, agents, forkAgentSession, forkChatFileCopy };
}

describe('AgentOrchestrator', () => {
  it('forks child chats, starts bounded child turns, and persists orchestration state', async () => {
    const harness = createHarness();
    await harness.orchestrator.init();

    const orchestration = await harness.orchestrator.spawn({
      parentChatId: 'parent',
      concurrencyLimit: 2,
      tasks: [
        { taskName: 'inspect_api', prompt: 'Inspect the API shape.' },
        { taskName: 'write_tests', prompt: 'Write focused tests.', thinkingMode: 'think-hard' },
      ],
    });

    expect(orchestration.children).toHaveLength(2);
    expect(orchestration.status).toBe('running');
    expect(harness.forkChatFileCopy).toHaveBeenCalledTimes(2);
    expect(harness.settings.setSessionName).toHaveBeenCalledWith(expect.any(String), 'Subagent: inspect_api');
    expect(harness.queue.submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Task name: inspect_api'),
      expect.objectContaining({ permissionMode: 'default', thinkingMode: 'think' }),
    );
    expect(harness.queue.submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Task name: write_tests'),
      expect.objectContaining({ thinkingMode: 'think-hard' }),
    );

    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'agent-orchestrations.json'), 'utf8'));
    expect(persisted.orchestrations[0].id).toBe(orchestration.id);
  });

  it('tracks messages and completion from child chat events', async () => {
    const harness = createHarness();
    await harness.orchestrator.init();
    const orchestration = await harness.orchestrator.spawn({
      parentChatId: 'parent',
      tasks: [{ taskName: 'inspect_api', prompt: 'Inspect the API shape.' }],
    });
    const childChatId = orchestration.children[0].childChatId;

    harness.orchestrator.recordMessages(childChatId, [
      { type: 'assistant-message', content: 'Finished the inspection.' },
    ]);
    harness.orchestrator.recordFinished(childChatId);
    await harness.orchestrator.flush();

    const updated = harness.orchestrator.get(orchestration.id);
    expect(updated.status).toBe('completed');
    expect(updated.children[0]).toMatchObject({
      status: 'completed',
      resultPreview: 'Finished the inspection.',
    });
  });

  it('waits until selected children reach final status', async () => {
    const harness = createHarness();
    await harness.orchestrator.init();
    const orchestration = await harness.orchestrator.spawn({
      parentChatId: 'parent',
      tasks: [{ taskName: 'inspect_api', prompt: 'Inspect the API shape.' }],
    });
    const child = orchestration.children[0];

    const waitPromise = harness.orchestrator.wait({
      orchestrationId: orchestration.id,
      childIds: [child.id],
      timeoutMs: 500,
    });
    queueMicrotask(() => harness.orchestrator.recordFinished(child.childChatId));

    const result = await waitPromise;
    await harness.orchestrator.flush();
    expect(result.timedOut).toBe(false);
    expect(result.orchestration.children[0].status).toBe('completed');
  });

  it('aborts non-final child agents', async () => {
    const harness = createHarness();
    await harness.orchestrator.init();
    const orchestration = await harness.orchestrator.spawn({
      parentChatId: 'parent',
      tasks: [{ taskName: 'inspect_api', prompt: 'Inspect the API shape.' }],
    });
    const child = orchestration.children[0];

    const updated = await harness.orchestrator.abort({
      orchestrationId: orchestration.id,
      childIds: [child.id],
    });
    await harness.orchestrator.flush();

    expect(harness.queue.abort).toHaveBeenCalledWith(child.childChatId);
    expect(updated.children[0].status).toBe('aborted');
  });

  it('rejects parent chats that are currently processing', async () => {
    const harness = createHarness();
    harness.agents.isAgentSessionRunning.mockReturnValue(true);
    await harness.orchestrator.init();

    await expect(harness.orchestrator.spawn({
      parentChatId: 'parent',
      tasks: [{ taskName: 'inspect_api', prompt: 'Inspect the API shape.' }],
    })).rejects.toThrow('Cannot spawn subagents while the parent chat is processing');
  });
});
