import { describe, expect, it, mock } from 'bun:test';
import { createOpenCodeAgent } from '../index.js';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';

function makeRuntime(overrides = {}) {
  return {
    startSession: mock(() => Promise.resolve('session')),
    runTurn: mock(() => Promise.resolve()),
    abort: mock(() => false),
    isRunning: mock(() => false),
    getRunningSessions: mock(() => []),
    resolvePermission: mock(() => Promise.resolve()),
    updateSessionSettings: mock(() => undefined),
    shutdown: mock(() => undefined),
    startPurgeTimer: mock(() => undefined),
    onMessages: mock(() => undefined),
    onProcessing: mock(() => undefined),
    onSessionCreated: mock(() => undefined),
    onFinished: mock(() => undefined),
    onFailed: mock(() => undefined),
    getModels: mock(() => []),
    getClient: mock(() => Promise.resolve({
      session: {
        get: mock(() => Promise.resolve({ data: { title: 'OpenCode title' } })),
        messages: mock(() => Promise.resolve({ data: [] })),
      },
    })),
    forkSession: mock(() => Promise.resolve('forked-session')),
    runSingleQuery: mock(() => Promise.resolve('answer')),
    isAvailable: mock(() => true),
    isTemporarilyUnavailable: mock(() => false),
    getUnavailableReason: mock(() => ''),
    getUnavailableRetryAfterMs: mock(() => 0),
    ...overrides,
  };
}

function forkArgs(agentSessionId = 'source-session') {
  return {
    sourceChatId: '1',
    targetChatId: '2',
    sourceSession: {
      agentId: 'opencode',
      agentSessionId,
      projectPath: '/repo',
    },
  };
}

describe('createOpenCodeAgent', () => {
  it('advertises full-session fork support only', () => {
    const agent = createOpenCodeAgent(makeRuntime());

    expect(agent.capabilities.supportsFork).toBe(true);
    expect(agent.capabilities.supportsForkAtMessage).toBe(false);
    expect(agent.capabilities.supportsForkWhileRunning).toBe(false);
    expect(agent.forkSession).toBeDefined();
  });

  it('forks through OpenCode and returns an artificial native path', async () => {
    const runtime = makeRuntime();
    const agent = createOpenCodeAgent(runtime);

    await expect(agent.forkSession(forkArgs(' source-session '))).resolves.toEqual({
      agentSessionId: 'forked-session',
      nativePath: '!opencode:forked-session',
    });

    expect(runtime.forkSession).toHaveBeenCalledWith('source-session', {
      projectPath: '/repo',
    });
  });

  it('rejects missing OpenCode source session ids', async () => {
    const runtime = makeRuntime();
    const agent = createOpenCodeAgent(runtime);

    await expect(agent.forkSession(forkArgs('   '))).rejects.toThrow(
      'Cannot fork OpenCode session: missing source session id',
    );

    expect(runtime.forkSession).not.toHaveBeenCalled();
  });

  it('loads OpenCode transcript messages through the SDK-backed history loader', async () => {
    const client = {
      session: {
        messages: mock(() => Promise.resolve({
          data: [
            {
              info: { role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
              parts: [{ type: 'text', text: 'hello' }],
            },
            {
              info: { role: 'assistant', time: { created: '2026-07-04T00:00:01.000Z' } },
              parts: [{ type: 'text', text: 'world' }],
            },
          ],
        })),
      },
    };
    const runtime = makeRuntime({
      getClient: mock(() => Promise.resolve(client)),
    });
    const agent = createOpenCodeAgent(runtime);

    const messages = await agent.transcript.loadMessages({
      agentId: 'opencode',
      agentSessionId: 'source-session',
      projectPath: '/repo',
    });

    expect(runtime.getClient).toHaveBeenCalledTimes(1);
    expect(client.session.messages).toHaveBeenCalledWith({ sessionID: 'source-session', directory: '/repo' });
    expect(messages[0]).toBeInstanceOf(UserMessage);
    expect(messages[0].content).toBe('hello');
    expect(messages[1]).toBeInstanceOf(AssistantMessage);
    expect(messages[1].content).toBe('world');
  });

  it('resolves artificial native paths for OpenCode sessions', async () => {
    const agent = createOpenCodeAgent(makeRuntime());

    await expect(agent.transcript.resolveNativePath({
      agentId: 'opencode',
      agentSessionId: 'source-session',
      projectPath: '/repo',
    })).resolves.toBe('!opencode:source-session');
  });
});
