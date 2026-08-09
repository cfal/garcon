import { describe, expect, it, mock } from 'bun:test';
import { CommandValidationError } from '../command-support.ts';
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
      queue: { ownsExecution: mock(() => false) },
      settings: {
        ensureInNormal: mock(async () => undefined),
        getChatName: mock(() => 'the source chat'),
        setSessionName: mock(async () => undefined),
        removeFromAllOrderLists: mock(async () => undefined),
        removeSessionName: mock(async () => undefined),
      },
      metadata: {
        getChatMetadata: mock(() => ({ firstMessage: 'the original ask' })),
        addNewChatMetadata: mock(() => undefined),
      },
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
      try {
        await preparation.prepare({ signal: AbortSignal.timeout(5_000) });
      } catch (error) {
        // Mirrors `accepted-input-handler`, which compensates a failed
        // preparation before surfacing the failure.
        await preparation.compensate();
        throw error;
      }
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

  it('recreates and schedules after a retryable pre-schedule failure', async () => {
    const { commands, support, added, scheduled } = harness();
    support.deps.ledger.getRecord = mock(async () => ({
      key: 'k',
      chatId: TARGET_ID,
      status: 'failed',
      errorCode: 'PRE_SCHEDULE_FAILED',
    }));

    await commands.submitSelfHandoffRun(request());

    // Compensation removed the target after the first attempt, so the retry has
    // to build it again rather than report a completed duplicate.
    expect(added).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(support.throwRecordedExecutionFailure).not.toHaveBeenCalled();
  });

  it('re-raises a recorded execution failure instead of a projection error', async () => {
    const { commands, support } = harness();
    const recorded = { key: 'k', chatId: TARGET_ID, status: 'failed', errorCode: 'PROVIDER_FAILURE' };
    support.deps.ledger.getRecord = mock(async () => recorded);
    support.throwRecordedExecutionFailure = mock(() => {
      throw new CommandValidationError('PROVIDER_FAILURE', 'the provider failed', 409);
    });

    await expect(commands.submitSelfHandoffRun(request())).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE',
    });
  });

  it('refuses a pre-existing target that is not this operation attempt', async () => {
    const { commands, chats } = harness();
    chats.set(TARGET_ID, sourceChat({ agentId: 'codex' }));

    await expect(commands.submitSelfHandoffRun(request())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('rolls back a target that fails after it was registered', async () => {
    const { commands, support, chats, captured } = harness();
    // The window between `addChat` publishing the target and `#createContinuation`
    // returning. Compensation has to cover it, or the failed handoff strands a
    // half-built chat in the registry.
    support.deps.settings.ensureInNormal = mock(async () => {
      throw new Error('settings flush failed');
    });

    await expect(commands.submitSelfHandoffRun(request())).rejects.toThrow('settings flush failed');

    expect(chats.has(TARGET_ID)).toBeFalse();
    expect(support.deps.settings.removeFromAllOrderLists).toHaveBeenCalledWith(TARGET_ID);
    expect(support.deps.settings.removeSessionName).toHaveBeenCalledWith(TARGET_ID);
    // Discarding while the target still referenced the segment would have left
    // the registry entry pointing at deleted pages. The writer root still has to
    // go, or every later sweep retains the segment for the process lifetime.
    expect(captured.prepared.discard).not.toHaveBeenCalled();
    expect(captured.prepared.releaseRoot).toHaveBeenCalledTimes(1);
  });

  it('keeps a surviving target named rather than orphaning it', async () => {
    const { commands, support, chats, captured } = harness();
    support.deps.chats.removeChat = mock(async () => {
      throw new Error('registry write failed');
    });
    support.deps.settings.ensureInNormal = mock(async () => {
      throw new Error('settings flush failed');
    });

    await expect(commands.submitSelfHandoffRun(request())).rejects.toThrow('settings flush failed');

    // The chat outlived the rollback, so its name and placement are still live
    // state; removing them would strand it in the sidebar with no title.
    expect(chats.has(TARGET_ID)).toBeTrue();
    expect(support.deps.settings.removeFromAllOrderLists).not.toHaveBeenCalled();
    expect(support.deps.settings.removeSessionName).not.toHaveBeenCalled();
    // A failed cleanup step must not strand the lease either.
    expect(captured.prepared.releaseRoot).toHaveBeenCalledTimes(1);
  });

  it('finishes clearing the name after the placement removal fails', async () => {
    const { commands, support } = harness();
    support.deps.settings.removeFromAllOrderLists = mock(async () => {
      throw new Error('order list write failed');
    });
    support.deps.settings.ensureInNormal = mock(async () => {
      throw new Error('settings flush failed');
    });

    await expect(commands.submitSelfHandoffRun(request())).rejects.toThrow('settings flush failed');

    expect(support.deps.settings.removeSessionName).toHaveBeenCalledWith(TARGET_ID);
  });

  it('discards the prepared segment when it fails before registering', async () => {
    const { commands, captured, chats } = harness();
    captured.assertUnchanged = mock(async () => {
      throw new Error('source changed');
    });

    await expect(commands.submitSelfHandoffRun(request())).rejects.toThrow('source changed');

    expect(captured.prepared.discard).toHaveBeenCalled();
    expect(chats.has(TARGET_ID)).toBeFalse();
  });

  it('keeps refusing a colliding target when the identical request is retried', async () => {
    const { commands, support, chats, scheduled } = harness();
    chats.set(TARGET_ID, sourceChat({ agentId: 'codex' }));
    // The ledger behaves for real: whatever the first call accepts is visible to
    // the second. Accepting before the collision check would make the record its
    // own provenance and let the retry schedule into the unrelated chat.
    let stored;
    support.deps.ledger.getRecord = mock(async () => stored);
    support.deps.ledger.accept = mock(async (input) => {
      stored = { key: 'k', chatId: input.chatId, turnId: input.turnId, status: 'accepted' };
      return { kind: 'accepted', record: stored };
    });

    for (const attempt of [1, 2]) {
      await expect(commands.submitSelfHandoffRun(request()), `attempt ${attempt}`)
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    expect(scheduled).toHaveLength(0);
    expect(support.deps.ledger.accept).not.toHaveBeenCalled();
  });

  it('returns its own already-created target on a lost-response retry', async () => {
    const { commands, support, chats, added } = harness();
    chats.set(TARGET_ID, sourceChat());
    support.deps.ledger.getRecord = mock(async () => ({
      key: 'k', chatId: TARGET_ID, status: 'scheduled', turnId: 'turn-1',
    }));
    support.deps.ledger.accept = mock(async () => ({
      kind: 'duplicate',
      record: { key: 'k', chatId: TARGET_ID, status: 'scheduled', turnId: 'turn-1' },
    }));

    const response = await commands.submitSelfHandoffRun(request());

    // Provenance is the ledger record, not its status: this retry must not
    // conflict, and must not build a second continuation.
    expect(response.chat.id).toBe(TARGET_ID);
    expect(added).toHaveLength(0);
  });

  it('binds attachments to the idempotency payload', async () => {
    const { commands, support } = harness();

    await commands.submitSelfHandoffRun(request({ images: [{ data: 'a', mediaType: 'image/png' }] }));

    expect(support.deps.ledger.accept.mock.calls[0][0].payload).toHaveProperty('images');
  });

  it('places the continuation in the chat list with a name and metadata', async () => {
    const { commands, support } = harness();

    await commands.submitSelfHandoffRun(request());

    expect(support.deps.settings.ensureInNormal).toHaveBeenCalledWith(TARGET_ID);
    expect(support.deps.settings.setSessionName).toHaveBeenCalledWith(TARGET_ID, 'the source chat');
    expect(support.deps.metadata.addNewChatMetadata)
      .toHaveBeenCalledWith(TARGET_ID, 'the original ask');
  });

  it('refuses any executing source, materializing or mid-turn', async () => {
    const { commands, support, added } = harness();
    support.deps.queue.ownsExecution = mock(() => true);

    await expect(commands.submitSelfHandoffRun(request())).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    expect(added).toHaveLength(0);
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
