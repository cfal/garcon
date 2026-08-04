import { describe, expect, it, mock } from 'bun:test';
import { ChatListProjector } from '../chat-list-projector.ts';

const CHAT_ID = '1783725900000900';

function makeSession(overrides = {}) {
  return {
    agentId: 'claude',
    agentSessionId: 'agent-session',
    nativeSession: null,
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: {
      claude: { ownerId: 'claude', schemaVersion: 1, values: {} },
    },
    projectPath: '/alias',
    tags: ['work'],
    model: 'opus',
    permissionMode: 'default',
    thinkingMode: 'none',
    ...overrides,
  };
}

function makeDeps() {
  const session = makeSession();
  return {
    session,
    deps: {
      registry: { getChat: mock(() => session) },
      settings: {
        getPinnedChatIds: mock(() => []),
        getNormalChatIds: mock(() => [CHAT_ID]),
        getArchivedChatIds: mock(() => []),
        getChatName: mock(() => null),
      },
      metadata: {
        listAllChatMetadata: mock(
          () =>
            new Map([
              [
                CHAT_ID,
                {
                  createdAt: '2026-01-01T00:00:00.000Z',
                  lastActivity: '2026-01-02T00:00:00.000Z',
                  firstMessage: 'First line\nSecond line',
                  lastMessage: 'Latest line',
                },
              ],
            ]),
        ),
        getChatMetadata: mock(() => ({
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivity: '2026-01-02T00:00:00.000Z',
          firstMessage: 'First line\nSecond line',
          lastMessage: 'Latest line',
        })),
      },
      processing: { phase: mock(() => 'running') },
      pathCache: {
        resolveProjectPath: mock(() =>
          Promise.resolve({
            available: true,
            effectiveProjectKey: '/real/project',
          }),
        ),
      },
    },
  };
}

describe('ChatListProjector', () => {
  it('projects the complete canonical list entry for list and command paths', async () => {
    const { deps, session } = makeDeps();
    const projector = new ChatListProjector(deps);
    const statuses = new Map([
      [
        '/alias',
        {
          available: true,
          effectiveProjectKey: '/real/project',
        },
      ],
    ]);

    const many = await projector.buildMany([[CHAT_ID, session]], statuses);
    const one = await projector.buildOne(CHAT_ID);

    expect(one).toEqual(many.get(CHAT_ID));
    expect(one).toMatchObject({
      id: CHAT_ID,
      effectiveProjectKey: '/real/project',
      orderGroup: 'normal',
      isPinned: false,
      isArchived: false,
      isActive: true,
      isProcessing: true,
      processingPhase: 'running',
      title: 'First line',
    });
  });

  it('builds a path-independent normalized summary', () => {
    const { deps, session } = makeDeps();
    session.tags = ['Review Needed', 'cli', 'review-needed'];
    session.modelProtocol = 'anthropic-messages';
    deps.pathCache.resolveProjectPath.mockImplementation(() => {
      throw new Error('summary must not resolve the project path');
    });
    const projector = new ChatListProjector(deps);

    expect(projector.buildSummary(CHAT_ID)).toEqual({
      chat: {
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: 'anthropic-messages',
        permissionMode: 'default',
        thinkingMode: 'none',
        title: 'First line',
        projectPath: '/alias',
        tags: ['cli', 'review-needed'],
        activity: {
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-02T00:00:00.000Z',
        },
      },
      processingPhase: 'running',
    });
    expect(deps.pathCache.resolveProjectPath).not.toHaveBeenCalled();
    expect(deps.processing.phase).toHaveBeenCalledTimes(1);
  });

  it('returns no summary for an unknown chat', () => {
    const { deps } = makeDeps();
    deps.registry.getChat.mockReturnValue(null);

    expect(new ChatListProjector(deps).buildSummary(CHAT_ID)).toBeNull();
    expect(deps.processing.phase).not.toHaveBeenCalled();
  });

  it('uses the default title when the first message starts with a blank line', () => {
    const { deps } = makeDeps();
    deps.metadata.getChatMetadata.mockReturnValue({
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-02T00:00:00.000Z',
      firstMessage: '\nFirst visible line',
      lastMessage: 'Latest line',
    });

    expect(new ChatListProjector(deps).buildSummary(CHAT_ID)?.chat.title).toBe(
      'New Session',
    );
  });

  it('uses pinned, normal, archived precedence for corrupt overlap', async () => {
    const { deps } = makeDeps();
    deps.settings.getPinnedChatIds.mockReturnValue([CHAT_ID]);
    deps.settings.getArchivedChatIds.mockReturnValue([CHAT_ID]);
    const projector = new ChatListProjector(deps);

    const entry = await projector.buildOne(CHAT_ID);

    expect(entry?.orderGroup).toBe('pinned');
    expect(entry?.isPinned).toBe(true);
    expect(entry?.isArchived).toBe(false);
  });

  it('omits unavailable sessions', async () => {
    const { deps, session } = makeDeps();
    const projector = new ChatListProjector(deps);

    const entries = await projector.buildMany(
      [[CHAT_ID, session]],
      new Map([
        [
          '/alias',
          {
            available: false,
            effectiveProjectKey: null,
          },
        ],
      ]),
    );

    expect(entries.size).toBe(0);
  });
});
