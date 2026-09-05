import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AssistantMessage,
  BashToolUseMessage,
  ErrorMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { ChatRegistry } from '../../chats/store.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { AgentRegistry } from '../registry.ts';

const CHAT_ID = '1783725900000200';
const AT = '2026-08-15T00:00:00.000Z';

describe('AgentRegistry session cache', () => {
  let root;
  let chats;
  let ledger;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-registry-'));
    chats = new ChatRegistry(root);
    await chats.init();
    chats.addChat({
      id: CHAT_ID,
      agentId: 'test',
      model: 'model-a',
      projectPath: '/repo',
      agentSettingsById: {
        test: { ownerId: 'test', schemaVersion: 1, values: {} },
      },
      parentChat: null,
    });
    ledger = new TranscriptLedgerService(
      new TranscriptLedgerStore(path.join(root, 'transcript-ledgers')),
      { now: () => AT },
    );
    ledger.initializeChat(CHAT_ID);
  });

  afterEach(async () => {
    ledger?.close();
    await chats?.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  function createRegistry(
    adoption = { ensure: () => Promise.reject(new Error('unused')) },
    preambles = { resolve: () => [] },
    integrations = {
      has: () => false,
      get: () => null,
      require: () => { throw new Error('unused'); },
      list: () => [],
    },
  ) {
    return new AgentRegistry({
      registry: chats,
      integrations,
      endpointResolver: {},
      getCarryOverRevision: () => 'carry-1',
      ledger,
      adoption,
      hasPendingOwnershipTransfer: () => false,
      preambles,
    });
  }

  function armBoundary(ownershipEpoch, kind = 'new-chat') {
    chats.updateChat(CHAT_ID, {
      agentOwnershipEpoch: ownershipEpoch,
      pendingPreambleBoundary: { kind, ownershipEpoch },
    });
  }

  function definition(id, title, content) {
    return {
      id,
      enabled: true,
      title,
      content,
      scope: { type: 'global' },
      createdAt: AT,
      updatedAt: AT,
    };
  }

  function admit(
    registry,
    clientMessageId,
    commandType = 'agent-run',
    content = `message-${clientMessageId}`,
    queued = false,
  ) {
    const method = queued ? 'admitQueuedInput' : 'admitInput';
    return registry[method](
      CHAT_ID,
      new UserMessage(AT, content),
      {
        clientRequestId: `request-${clientMessageId}`,
        clientMessageId,
        transcriptViewId: ledger.currentView(CHAT_ID).viewId,
        turnId: `turn-${clientMessageId}`,
        commandType,
      },
    );
  }

  it('consumes a pending boundary with the current ordered preambles', async () => {
    armBoundary('epoch-current');
    const resolve = mock(() => [
      definition('preamble-a', 'First', 'first body'),
      definition('preamble-b', 'Second', 'second body'),
    ]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve },
    );

    await expect(admit(registry, 'boundary-current')).resolves.toEqual({ inserted: true });

    expect(resolve).toHaveBeenCalledWith('/repo');
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    const rows = ledger.currentRows(CHAT_ID);
    expect(rows.map((row) => row.kind)).toEqual(['notice', 'user-input']);
    expect(rows[0].detail).toEqual({
      type: 'preamble-application',
      preambles: [
        { id: 'preamble-a', title: 'First' },
        { id: 'preamble-b', title: 'Second' },
      ],
    });
    expect(rows[1].detail.preambleBoundary).toEqual({
      kind: 'new-chat',
      ownershipEpoch: 'epoch-current',
    });
    expect(ledger.takePreparedInput(CHAT_ID, 'boundary-current').providerPrefix).toContain(
      'first body\n\nsecond body',
    );
  });

  it('consumes a zero-match boundary and does not apply later catalog changes', async () => {
    armBoundary('epoch-empty');
    let resolved = [];
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve: () => resolved },
    );

    await admit(registry, 'empty-first');
    resolved = [definition('preamble-later', 'Later', 'later body')];
    await admit(registry, 'empty-second');

    const rows = ledger.currentRows(CHAT_ID);
    expect(rows.map((row) => row.kind)).toEqual(['user-input', 'user-input']);
    expect(rows[0].detail.preambleBoundary).toEqual({
      kind: 'new-chat',
      ownershipEpoch: 'epoch-empty',
    });
    expect(rows[1].detail.preambleBoundary).toBeNull();
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
  });

  it('repairs a stale pending boundary from its authoritative ledger proof', async () => {
    const boundary = { kind: 'fork', ownershipEpoch: 'epoch-stale' };
    ledger.appendInputAndCompose({
      chatId: CHAT_ID,
      viewId: ledger.currentView(CHAT_ID).viewId,
      message: new UserMessage(AT, 'already committed'),
      attachments: [],
      clientMessageId: 'proof-existing',
      steer: false,
      preambleBoundary: boundary,
      preambles: [],
    });
    armBoundary('epoch-stale', 'fork');
    const resolve = mock(() => [definition('preamble-stale', 'Stale', 'must not apply')]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve },
    );

    await admit(registry, 'after-stale-proof');

    expect(resolve).not.toHaveBeenCalled();
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    expect(ledger.currentRows(CHAT_ID).at(-1).detail.preambleBoundary).toBeNull();
  });

  it('does not let an older proof consume a newer ownership epoch', async () => {
    ledger.appendInputAndCompose({
      chatId: CHAT_ID,
      viewId: ledger.currentView(CHAT_ID).viewId,
      message: new UserMessage(AT, 'old proof'),
      attachments: [],
      clientMessageId: 'proof-old',
      steer: false,
      preambleBoundary: { kind: 'agent-switch', ownershipEpoch: 'epoch-old' },
      preambles: [],
    });
    armBoundary('epoch-new', 'agent-switch');
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve: () => [definition('preamble-new', 'New', 'new body')] },
    );

    await admit(registry, 'new-epoch');

    expect(ledger.currentRows(CHAT_ID).at(-1).detail.preambleBoundary).toEqual({
      kind: 'agent-switch',
      ownershipEpoch: 'epoch-new',
    });
  });

  it('excludes duplicate submissions from boundary application', async () => {
    armBoundary('epoch-steer');
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve: () => [definition('preamble-one', 'One', 'one body')] },
    );

    await admit(registry, 'duplicate-boundary');
    armBoundary('epoch-steer');
    await expect(admit(registry, 'duplicate-boundary')).resolves.toEqual({ inserted: false });

    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    expect(ledger.currentRows(CHAT_ID).filter((row) => row.kind === 'notice')).toHaveLength(1);
  });

  it('returns a slash-leading duplicate before gating a newly armed boundary', async () => {
    const resolve = mock(() => [definition('preamble-one', 'One', 'one body')]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve },
    );

    await admit(registry, 'slash-retry', 'agent-run', '/provider-command');
    ledger.takePreparedInput(CHAT_ID, 'slash-retry');
    armBoundary('epoch-switch', 'agent-switch');

    await expect(registry.admitInput(
      CHAT_ID,
      new UserMessage(AT, '/provider-command'),
      {
        clientRequestId: 'request-slash-retry-again',
        clientMessageId: 'slash-retry',
        transcriptViewId: ledger.currentView(CHAT_ID).viewId,
        turnId: 'turn-slash-retry-again',
        commandType: 'agent-run',
      },
    )).resolves.toEqual({ inserted: false });

    expect(resolve).not.toHaveBeenCalled();
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'agent-switch',
      ownershipEpoch: 'epoch-switch',
    });
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(1);

    await expect(registry.admitInput(
      CHAT_ID,
      new UserMessage(AT, '/different-command'),
      {
        clientRequestId: 'request-slash-retry-changed',
        clientMessageId: 'slash-retry',
        transcriptViewId: ledger.currentView(CHAT_ID).viewId,
        turnId: 'turn-slash-retry-changed',
        commandType: 'agent-run',
      },
    )).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'agent-switch',
      ownershipEpoch: 'epoch-switch',
    });
  });

  for (const queued of [false, true]) {
    it(`rejects a ${queued ? 'queued' : 'direct'} provider slash command until matching preambles are sent`, async () => {
      armBoundary('epoch-slash', 'fork');
      const resolve = mock(() => [definition('preamble-one', 'One', 'one body')]);
      const registry = createRegistry(
        { ensure: async () => ledger.currentView(CHAT_ID) },
        { resolve },
      );

      await expect(Promise.resolve().then(() => (
        admit(registry, 'provider-slash', 'agent-run', '  /provider-command', queued)
      ))).rejects.toMatchObject({
        code: 'PREAMBLE_SLASH_COMMAND_BLOCKED',
        status: 422,
      });

      expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
        kind: 'fork',
        ownershipEpoch: 'epoch-slash',
      });
      expect(ledger.currentRows(CHAT_ID)).toEqual([]);

      await admit(registry, 'provider-prompt', 'agent-run', 'continue', queued);

      expect(resolve).toHaveBeenCalledWith('/repo');
      expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
      expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual(['notice', 'user-input']);
    });
  }

  it('allows a provider slash command when no enabled preamble matches and consumes the boundary', async () => {
    armBoundary('epoch-empty-slash');
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve: () => [] },
    );

    await expect(admit(registry, 'empty-slash', 'agent-run', '/provider-command')).resolves.toEqual({
      inserted: true,
    });

    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    expect(ledger.currentRows(CHAT_ID)).toEqual([
      expect.objectContaining({
        kind: 'user-input',
        detail: expect.objectContaining({
          preambleBoundary: {
            kind: 'new-chat',
            ownershipEpoch: 'epoch-empty-slash',
          },
        }),
      }),
    ]);
  });

  it('keeps Garcon-owned goal control outside preamble boundary handling', async () => {
    armBoundary('epoch-goal-control', 'fork');
    const resolve = mock(() => [definition('preamble-one', 'One', 'one body')]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { resolve },
    );

    await admit(registry, 'goal-control', 'goal-control', '/goal');

    expect(resolve).not.toHaveBeenCalled();
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'fork',
      ownershipEpoch: 'epoch-goal-control',
    });
    expect(ledger.currentRows(CHAT_ID)).toEqual([
      expect.objectContaining({
        kind: 'user-input',
        detail: expect.objectContaining({ preambleBoundary: null }),
      }),
    ]);
  });

  it('updates the execution cache before an accepted session publish returns', () => {
    const registry = createRegistry();
    expect(registry).toBeDefined();

    registry.publishSessionFact(CHAT_ID, {
      agentSessionId: 'native-1',
      nativeSession: {
        ownerId: 'test',
        schemaVersion: 1,
        value: { path: '/tmp/native.jsonl' },
      },
      nativeSeedReceipt: null,
    });

    expect(chats.getChat(CHAT_ID)).toMatchObject({
      agentSessionId: 'native-1',
      nativeSession: {
        ownerId: 'test',
        value: { path: '/tmp/native.jsonl' },
      },
    });
    expect(chats.getChatByAgentSessionId('native-1')?.[0]).toBe(CHAT_ID);
  });

  it('caches a session fact that arrives after interruption for future resume', async () => {
    const producer = ledger.openProducer(CHAT_ID, 'test');
    ledger.beginRun(CHAT_ID, 'run-1');
    expect(ledger.interruptRun(CHAT_ID)).toMatchObject({ outcome: 'interrupted' });
    await Promise.resolve();
    const registry = createRegistry();
    expect(registry).toBeDefined();

    producer.sink.publish({
      type: 'session',
      session: {
        agentSessionId: 'native-late',
        nativeSession: {
          ownerId: 'test',
          schemaVersion: 1,
          value: { path: '/tmp/native-late.jsonl' },
        },
        nativeSeedReceipt: null,
      },
    });

    expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
      'run-ended',
      'session',
    ]);
    expect(chats.getChat(CHAT_ID)).toMatchObject({
      agentSessionId: 'native-late',
      nativeSession: {
        ownerId: 'test',
        value: { path: '/tmp/native-late.jsonl' },
      },
    });
    expect(chats.getChatByAgentSessionId('native-late')?.[0]).toBe(CHAT_ID);
  });

  it('continues transcript listener delivery after a listener fails', async () => {
    const registry = createRegistry();
    const delivered = mock(() => undefined);
    registry.onTranscriptCommitted(() => { throw new Error('listener failed'); });
    registry.onTranscriptCommitted(delivered);
    const viewId = ledger.currentView(CHAT_ID).viewId;

    ledger.appendChatRow({
      chatId: CHAT_ID,
      viewId,
      clientMessageId: 'listener-notice',
      type: 'notice',
      content: 'listener isolation',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({
      chatId: CHAT_ID,
      type: 'rows',
    }));
  });

  it('keeps chat rows and provider errors out of the conversational preview fold', async () => {
    const viewId = ledger.currentView(CHAT_ID).viewId;
    ledger.appendInputAndCompose({
      chatId: CHAT_ID,
      viewId,
      message: new UserMessage(AT, 'preview-first-user'),
      attachments: [],
      clientMessageId: 'preview-message-1',
      steer: false,
    });
    const producer = ledger.openProducer(CHAT_ID, 'test');
    producer.sink.publish({
      type: 'session',
      session: { agentSessionId: 'native-preview', nativeSession: null, nativeSeedReceipt: null },
    });
    producer.sink.publish({
      type: 'rows',
      rows: [{ message: new AssistantMessage(AT, 'preview-initial-answer') }],
    });
    ledger.beginRun(CHAT_ID, 'preview-run');
    producer.sink.publish({
      type: 'permission',
      runId: 'preview-run',
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: 'preview-incarnation',
        requestedTool: new BashToolUseMessage(AT, 'preview-tool', 'pwd'),
        options: [],
      },
      decision: {
        permissionOccurrenceId: 'preview-incarnation',
        respond: async () => {},
      },
    });
    producer.sink.publish({
      type: 'run-ended',
      runId: 'preview-run',
      outcome: 'finished',
    });
    producer.sink.publish({
      type: 'rows',
      rows: [{ message: new AssistantMessage(AT, 'preview-late-answer') }],
    });
    producer.sink.publish({
      type: 'rows',
      rows: [{ message: new ErrorMessage('2099-01-01T00:00:00.000Z', 'provider error') }],
    });
    producer.sink.publish({
      type: 'permission',
      runId: 'preview-run',
      lifecycle: {
        kind: 'cancelled',
        permissionOccurrenceId: 'preview-incarnation',
        reason: 'already ended',
      },
    });
    ledger.appendChatRow({
      chatId: CHAT_ID,
      viewId,
      clientMessageId: 'preview-notice-row',
      type: 'notice',
      content: 'preview-hidden-notice',
    });
    ledger.appendChatRow({
      chatId: CHAT_ID,
      viewId,
      clientMessageId: 'preview-error-row',
      type: 'error',
      content: 'preview-hidden-error',
    });
    await Promise.resolve();
    const registry = createRegistry({
      ensure: async () => ledger.currentView(CHAT_ID),
    });

    await expect(registry.getPreview(chats.getChat(CHAT_ID), CHAT_ID)).resolves.toEqual({
      preview: {
        firstMessage: 'preview-first-user',
        lastMessage: 'preview-late-answer',
        createdAt: AT,
        lastActivity: AT,
      },
    });
  });
});
