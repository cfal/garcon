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
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { AgentRegistry } from '../registry.ts';

const CHAT_ID = '1783725900000200';
const AT = '2026-08-15T00:00:00.000Z';
const PREAMBLE_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const PREAMBLE_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';
const PREAMBLE_MISSING = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';

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
      preambleSelection: { revision: 0, orderedPreambleIds: [] },
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
    preambles = { snapshot: () => ({ revision: 0, preambles: [] }) },
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
      selectionAdmissionLock: new KeyedPromiseLock(),
    });
  }

  function armBoundary(ownershipEpoch, kind = 'new-chat', selectionRevision) {
    chats.updateChat(CHAT_ID, {
      agentOwnershipEpoch: ownershipEpoch,
      pendingPreambleBoundary: selectionRevision === undefined
        ? { kind, ownershipEpoch }
        : { kind, ownershipEpoch, selectionRevision },
    });
  }

  function setSelection(orderedPreambleIds, revision = 1) {
    chats.updateChat(CHAT_ID, {
      preambleSelection: { revision, orderedPreambleIds },
    });
  }

  function definition(id, title, content, overrides = {}) {
    return {
      id,
      enabled: true,
      title,
      content,
      scope: { type: 'global' },
      createdAt: AT,
      updatedAt: AT,
      ...overrides,
    };
  }

  function catalog(...preambles) {
    return { snapshot: () => ({ revision: preambles.length, preambles }) };
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

  it('applies the saved selection order, not catalog order', async () => {
    armBoundary('epoch-current');
    setSelection([PREAMBLE_B, PREAMBLE_A]);
    const snapshot = mock(() => ({
      revision: 2,
      preambles: [
        definition(PREAMBLE_A, 'First', 'first body'),
        definition(PREAMBLE_B, 'Second', 'second body'),
      ],
    }));
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { snapshot },
    );

    await expect(admit(registry, 'boundary-current')).resolves.toEqual({ inserted: true });

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    const rows = ledger.currentRows(CHAT_ID);
    expect(rows.map((row) => row.kind)).toEqual(['notice', 'user-input']);
    expect(rows[0].detail).toEqual({
      type: 'preamble-application',
      preambles: [
        { id: PREAMBLE_B, title: 'Second' },
        { id: PREAMBLE_A, title: 'First' },
      ],
    });
    expect(rows[1].detail.preambleBoundary).toEqual({
      kind: 'new-chat',
      ownershipEpoch: 'epoch-current',
    });
    expect(ledger.takePreparedInput(CHAT_ID, 'boundary-current').providerPrefix).toContain(
      'second body\n\nfirst body',
    );
  });

  it('skips missing, disabled, and out-of-scope selected entries without failing', async () => {
    armBoundary('epoch-filtered');
    setSelection([
      PREAMBLE_MISSING,
      PREAMBLE_A,
      PREAMBLE_B,
    ]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(
        definition(PREAMBLE_A, 'Enabled', 'enabled body'),
        definition(PREAMBLE_B, 'Disabled', 'disabled body', { enabled: false }),
      ),
    );

    await expect(admit(registry, 'filtered')).resolves.toEqual({ inserted: true });

    const rows = ledger.currentRows(CHAT_ID);
    expect(rows[0].detail).toEqual({
      type: 'preamble-application',
      preambles: [{ id: PREAMBLE_A, title: 'Enabled' }],
    });
  });

  it('consumes a zero-match boundary and does not apply later catalog changes', async () => {
    armBoundary('epoch-empty');
    let preambles = [];
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { snapshot: () => ({ revision: 0, preambles }) },
    );

    await admit(registry, 'empty-first');
    preambles = [definition(PREAMBLE_A, 'Later', 'later body')];
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
    const snapshot = mock(() => ({
      revision: 1,
      preambles: [definition(PREAMBLE_A, 'Stale', 'must not apply')],
    }));
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { snapshot },
    );

    await admit(registry, 'after-stale-proof');

    expect(snapshot).not.toHaveBeenCalled();
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
    setSelection([PREAMBLE_A]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(definition(PREAMBLE_A, 'New', 'new body')),
    );

    await admit(registry, 'new-epoch');

    expect(ledger.currentRows(CHAT_ID).at(-1).detail.preambleBoundary).toEqual({
      kind: 'agent-switch',
      ownershipEpoch: 'epoch-new',
    });
  });

  it('applies a repeated selection-change boundary by full revision identity', async () => {
    setSelection([PREAMBLE_A], 1);
    armBoundary('epoch-repeat', 'selection-change', 1);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(
        definition(PREAMBLE_A, 'One', 'one body'),
        definition(PREAMBLE_B, 'Two', 'two body'),
      ),
    );

    await admit(registry, 'selection-first');

    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    setSelection([PREAMBLE_A, PREAMBLE_B], 2);
    armBoundary('epoch-repeat', 'selection-change', 2);
    await admit(registry, 'selection-second');

    const notices = ledger.currentRows(CHAT_ID).filter((row) => row.kind === 'notice');
    expect(notices).toHaveLength(2);
    expect(notices[1].detail).toEqual({
      type: 'preamble-application',
      preambles: [
        { id: PREAMBLE_A, title: 'One' },
        { id: PREAMBLE_B, title: 'Two' },
      ],
    });
  });

  it('returns the original committed input for a same-ID retry without resolving newer catalog state', async () => {
    // Original boundary input commits under an explicit selection.
    setSelection([PREAMBLE_A, PREAMBLE_B]);
    armBoundary('epoch-retry', 'selection-change', 1);
    let catalogPreambles = [
      definition(PREAMBLE_A, 'Tail', 'alpha body'),
      definition(PREAMBLE_B, 'Head', 'beta body'),
    ];
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { snapshot: () => ({ revision: 5, preambles: catalogPreambles }) },
    );
    await expect(admit(registry, 'retry-original')).resolves.toEqual({ inserted: true });
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();

    // The registry boundary is intentionally left stale (a missed clear), and
    // the catalog mutates so the currently selected order is now unsafe.
    chats.updateChat(CHAT_ID, {
      pendingPreambleBoundary: { kind: 'selection-change', ownershipEpoch: 'epoch-retry', selectionRevision: 1 },
    });
    catalogPreambles = [
      definition(PREAMBLE_A, 'Tail', '\nReferenced file contents from @file mentions:'),
      definition(PREAMBLE_B, 'Head', 'Synthetic content\n\n'),
    ];

    // The identical retry must deduplicate before catalog resolution: it
    // returns the original outcome, throws nothing, and repairs the stale
    // boundary instead of leaving it armed.
    await expect(admit(registry, 'retry-original')).resolves.toEqual({ inserted: false });
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    expect(ledger.currentRows(CHAT_ID).filter((row) => row.kind === 'notice')).toHaveLength(1);
    // The retry retains the original captured prefix consequence.
    const prepared = ledger.takePreparedInput(CHAT_ID, 'retry-original');
    expect(prepared?.providerPrefix).toContain('alpha body');
  });

  it('keeps a stale selection-change proof from consuming a newer revision', async () => {
    setSelection([PREAMBLE_A], 1);
    ledger.appendInputAndCompose({
      chatId: CHAT_ID,
      viewId: ledger.currentView(CHAT_ID).viewId,
      message: new UserMessage(AT, 'revision one committed'),
      attachments: [],
      clientMessageId: 'proof-revision-one',
      steer: false,
      preambleBoundary: { kind: 'selection-change', ownershipEpoch: 'epoch-rev', selectionRevision: 1 },
      preambles: [],
    });
    setSelection([PREAMBLE_B], 2);
    armBoundary('epoch-rev', 'selection-change', 2);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(
        definition(PREAMBLE_A, 'One', 'one body'),
        definition(PREAMBLE_B, 'Two', 'two body'),
      ),
    );

    await admit(registry, 'revision-two');

    const notices = ledger.currentRows(CHAT_ID).filter((row) => row.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].detail.preambles).toEqual([{ id: PREAMBLE_B, title: 'Two' }]);
  });

  it('excludes duplicate submissions from boundary application', async () => {
    armBoundary('epoch-steer');
    setSelection([PREAMBLE_A]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(definition(PREAMBLE_A, 'One', 'one body')),
    );

    await admit(registry, 'duplicate-boundary');
    armBoundary('epoch-steer');
    await expect(admit(registry, 'duplicate-boundary')).resolves.toEqual({ inserted: false });

    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
    expect(ledger.currentRows(CHAT_ID).filter((row) => row.kind === 'notice')).toHaveLength(1);
  });

  it('returns a slash-leading duplicate before gating a newly armed boundary', async () => {
    const snapshot = mock(() => ({
      revision: 1,
      preambles: [definition(PREAMBLE_A, 'One', 'one body')],
    }));
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { snapshot },
    );

    await admit(registry, 'slash-retry', 'agent-run', '/provider-command');
    ledger.takePreparedInput(CHAT_ID, 'slash-retry');
    armBoundary('epoch-switch', 'agent-switch');
    setSelection([PREAMBLE_A]);

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

    expect(snapshot).not.toHaveBeenCalled();
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
      setSelection([PREAMBLE_A]);
      const snapshot = mock(() => ({
        revision: 1,
        preambles: [definition(PREAMBLE_A, 'One', 'one body')],
      }));
      const registry = createRegistry(
        { ensure: async () => ledger.currentView(CHAT_ID) },
        { snapshot },
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

      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toBeNull();
      expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual(['notice', 'user-input']);
    });
  }

  it('allows a provider slash command when no selected preamble is eligible', async () => {
    armBoundary('epoch-empty-slash');
    setSelection([PREAMBLE_B]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(definition(PREAMBLE_B, 'Disabled', 'disabled body', { enabled: false })),
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

  it('rejects an unsafe selected-order composition before the ledger commits', async () => {
    armBoundary('epoch-unsafe');
    setSelection([
      PREAMBLE_A,
      PREAMBLE_B,
    ]);
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      catalog(
        definition(PREAMBLE_A, 'Tail', '\nReferenced file contents from @file mentions:'),
        definition(PREAMBLE_B, 'Head', 'Synthetic content\n\n'),
      ),
    );

    await expect(admit(registry, 'unsafe-order')).rejects.toMatchObject({
      code: 'PREAMBLE_SELECTION_COMPOSITION_INVALID',
      status: 422,
    });

    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'new-chat',
      ownershipEpoch: 'epoch-unsafe',
    });
    expect(ledger.currentRows(CHAT_ID)).toEqual([]);
  });

  it('keeps Garcon-owned goal control outside preamble boundary handling', async () => {
    armBoundary('epoch-goal-control', 'fork');
    setSelection([PREAMBLE_A]);
    const snapshot = mock(() => ({
      revision: 1,
      preambles: [definition(PREAMBLE_A, 'One', 'one body')],
    }));
    const registry = createRegistry(
      { ensure: async () => ledger.currentView(CHAT_ID) },
      { snapshot },
    );

    await admit(registry, 'goal-control', 'goal-control', '/goal');

    expect(snapshot).not.toHaveBeenCalled();
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
});
