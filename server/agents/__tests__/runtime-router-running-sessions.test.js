import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';

function makeRouter(providerSessions, mappings = {}) {
  const agents = Object.entries(providerSessions).map(([id, runningSessions]) => ({
    id,
    runtime: {
      getRunningSessions: typeof runningSessions === 'function'
        ? mock(runningSessions)
        : mock(() => runningSessions),
    },
  }));
  const registry = {
    getChatByAgentSessionId: mock((agentSessionId) => {
      const chatId = mappings[agentSessionId];
      return chatId ? [chatId, { agentSessionId }] : null;
    }),
  };
  const directory = {
    list: mock(() => agents),
  };

  return new AgentRuntimeRouter({
    registry,
    directory,
    endpointResolver: {},
    events: {},
  });
}

describe('AgentRuntimeRouter running chat snapshots', () => {
  it('maps provider session IDs to a sorted unique chat ID snapshot', () => {
    const router = makeRouter(
      {
        claude: [{ id: 'claude-session' }, { id: 'shared-session' }],
        codex: [{ id: 'codex-session' }, { id: 'shared-session' }],
      },
      {
        'claude-session': 'chat-z',
        'codex-session': 'chat-a',
        'shared-session': 'chat-shared',
      },
    );

    expect(router.getRunningChatIdsSnapshot()).toEqual([
      'chat-a',
      'chat-shared',
      'chat-z',
    ]);
  });

  it('returns an authoritative empty snapshot when no provider has running sessions', () => {
    const router = makeRouter({ claude: [], codex: [] });

    expect(router.getRunningChatIdsSnapshot()).toEqual([]);
  });

  it('fails when a provider runtime getter throws', () => {
    const router = makeRouter({
      claude: () => {
        throw new Error('runtime unavailable');
      },
    });

    expect(() => router.getRunningChatIdsSnapshot()).toThrow('runtime unavailable');
  });

  it('fails when a provider returns a non-array running-session value', () => {
    const router = makeRouter({ claude: { id: 'session-1' } });

    expect(() => router.getRunningChatIdsSnapshot()).toThrow(
      'Running sessions for claude are not an array',
    );
  });

  it('fails when a running session has no valid ID', () => {
    for (const invalidSession of ['bare-session-id', {}, { id: '' }, { id: '   ' }, null]) {
      const router = makeRouter({ claude: [invalidSession] });

      expect(() => router.getRunningChatIdsSnapshot()).toThrow(
        'Running session for claude has no ID',
      );
    }
  });

  it('fails closed during the normal runtime-to-registry pre-bind window', () => {
    const router = makeRouter({ claude: [{ id: 'starting-session' }] });

    expect(() => router.getRunningChatIdsSnapshot()).toThrow(
      'Running chat snapshot has 1 unmapped session(s) (oldest age unknown)',
    );
  });

  it('reports aggregate content-free diagnostics without returning a partial snapshot', () => {
    const router = makeRouter(
      {
        claude: [
          { id: 'mapped-session' },
          { id: 'orphan-session', startedAt: '2020-01-01T00:00:00.000Z' },
        ],
        codex: [{ id: 'second-orphan', startedAt: '2021-01-01T00:00:00.000Z' }],
      },
      { 'mapped-session': 'chat-mapped' },
    );

    expect.assertions(5);
    try {
      router.getRunningChatIdsSnapshot();
    } catch (error) {
      expect(error.message).toMatch(/^Running chat snapshot has 2 unmapped session\(s\) \(oldest age \d+s\)$/);
      expect(error.message).not.toContain('orphan-session');
      expect(error.message).not.toContain('second-orphan');
      expect(error.message).not.toContain('claude');
      expect(error.message).not.toContain('codex');
    }
  });
});
