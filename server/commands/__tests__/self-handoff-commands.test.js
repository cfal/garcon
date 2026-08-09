import { describe, expect, it, mock } from 'bun:test';
import { SelfHandoffCommands } from '../self-handoff-commands.ts';

const SOURCE_ID = '1786077000000001';
const TARGET_ID = '1786077000000002';

function sourceChat(overrides = {}) {
  return {
    agentId: 'claude',
    model: 'opus',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    projectPath: '/workspace',
    agentSessionId: 'session-a',
    agentOwnershipEpoch: 'epoch-1',
    tags: ['work'],
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettingsById: { claude: { ownerId: 'claude', schemaVersion: 1, values: {} } },
    carryOverSegments: [{ id: 'seg-old', agentId: 'claude', model: 'opus' }],
    nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    ...overrides,
  };
}

function harness({ source = sourceChat(), capture } = {}) {
  const chats = new Map([[SOURCE_ID, source]]);
  const added = [];
  const captured = capture ?? {
    segments: [
      ...source.carryOverSegments,
      { id: 'seg-new', agentId: 'claude', model: 'opus', storedMessageCount: 4 },
    ],
    prepared: { releaseRoot: mock(() => undefined), discard: mock(async () => undefined) },
    assertUnchanged: mock(async () => undefined),
  };
  const scheduled = [];
  const support = {
    deps: {
      chats: {
        getChat: (id) => chats.get(id) ?? null,
        addChat: mock((entry) => {
          added.push(entry);
          chats.set(entry.id, entry);
          return true;
        }),
        removeChat: mock(async (id) => chats.delete(id)),
      },
      ledger: {
        getRecord: mock(async () => undefined),
        accept: mock(async (input) => ({
          kind: 'accepted',
          record: { key: 'k', chatId: input.chatId, turnId: input.turnId, status: 'accepted' },
        })),
      },
      handoffs: { captureContinuationSegments: mock(async () => captured) },
    },
    assertContent: mock(() => undefined),
    requireChatId: (value) => value,
    requireClientRequestId: (value) => value,
    withChatMutationLocks: (_ids, fn) => fn(),
    assertAttachmentsSupported: mock(async () => undefined),
    throwRecordedExecutionFailure: mock(() => undefined),
    projectCommandChat: mock(async (id) => ({ id })),
    scheduleAcceptedHttpRun: mock(async (_ledger, input, _ids, commandType, preparation) => {
      scheduled.push({ input, commandType });
      await preparation.prepare({ signal: AbortSignal.timeout(5_000) });
      return { status: 'accepted', turnId: 'turn-1' };
    }),
  };
  return { commands: new SelfHandoffCommands(support), support, chats, added, scheduled, captured };
}

function request(overrides = {}) {
  return {
    clientRequestId: 'request-1',
    clientMessageId: 'message-1',
    sourceChatId: SOURCE_ID,
    chatId: TARGET_ID,
    command: 'keep going on the auth fix',
    ...overrides,
  };
}

describe('self handoff commands', () => {
  it('creates a target under the same agent carrying the captured segments', async () => {
    const { commands, added, captured, support } = harness();

    const response = await commands.submitSelfHandoffRun(request());

    expect(response.chat.id).toBe(TARGET_ID);
    expect(added).toHaveLength(1);
    const target = added[0];
    expect(target.agentId).toBe('claude');
    expect(target.model).toBe('opus');
    expect(target.projectPath).toBe('/workspace');
    expect(target.carryOverSegments).toEqual(captured.segments);
    // A fresh provider session is what makes the target seed itself from the
    // projection on its first turn.
    expect(target.agentSessionId).toBeNull();
    expect(target.nativeSession).toBeNull();
    expect(target.nativeSeedReceipt).toBeNull();
    expect(target.agentOwnershipEpoch).not.toBe('epoch-1');
    expect(captured.prepared.releaseRoot).toHaveBeenCalledTimes(1);
    expect(support.deps.handoffs.captureContinuationSegments.mock.calls[0][0].target)
      .toEqual({ agentId: 'claude', model: 'opus' });
  });

  it('leaves the source chat untouched', async () => {
    const { commands, chats } = harness();

    await commands.submitSelfHandoffRun(request());

    const source = chats.get(SOURCE_ID);
    expect(source.agentSessionId).toBe('session-a');
    expect(source.agentOwnershipEpoch).toBe('epoch-1');
    expect(source.carryOverSegments).toEqual([{ id: 'seg-old', agentId: 'claude', model: 'opus' }]);
  });

  it('submits the prompt as the target chat first turn', async () => {
    const { commands, scheduled } = harness();

    await commands.submitSelfHandoffRun(request());

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].input.chatId).toBe(TARGET_ID);
    expect(scheduled[0].input.command).toBe('keep going on the auth fix');
  });

  it('discards the prepared segment when registration fails', async () => {
    const { commands, support, captured } = harness();
    support.deps.chats.addChat = mock(() => false);

    await expect(commands.submitSelfHandoffRun(request())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(captured.prepared.discard).toHaveBeenCalledTimes(1);
    expect(captured.prepared.releaseRoot).not.toHaveBeenCalled();
  });

  it('refuses a quarantined source rather than continuing empty history', async () => {
    const { commands } = harness({
      source: sourceChat({ carryOverMigrationQuarantine: { artifactId: 'a', errorCode: 'E' } }),
    });

    await expect(commands.submitSelfHandoffRun(request())).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
  });

  it('refuses a missing source and a self-targeting request', async () => {
    const { commands } = harness();

    await expect(commands.submitSelfHandoffRun(request({ sourceChatId: 'missing' })))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(commands.submitSelfHandoffRun(request({ chatId: SOURCE_ID })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
