import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatRegistry } from '../../chats/store.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import {
  ChatPreambleSelectionPartialError,
  ChatPreambleSelectionService,
} from '../chat-selection-service.ts';

const CHAT_ID = '1783725900000200';
const AT = '2026-09-05T00:00:00.000Z';
const ID_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';

let root;
let chats;
let ledger;
let viewId;
let preamblesSnapshot;
let ownershipPending;
let committedFlags;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function catalogEntry(id, title, overrides = {}) {
  return {
    id,
    enabled: true,
    title,
    content: `body ${title}`,
    scope: { type: 'global' },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function makeService(overrides = {}) {
  const chatMutationLock = new KeyedPromiseLock();
  const selectionAdmissionLock = new KeyedPromiseLock();
  const onSelectionCommitted = overrides.onSelectionCommitted ?? mock(() => undefined);
  const registryPatch = overrides.registryPatch ?? {};
  const service = new ChatPreambleSelectionService({
    registry: {
      getChat: (chatId) => chats.getChat(chatId),
      updateChatPhased: async (chatId, patch) => {
        if (registryPatch.reject) throw registryPatch.reject;
        const result = await chats.updateChatPhased(chatId, patch);
        committedFlags.push({ chatId, patch });
        return result;
      },
      reconcileUnknownDurability: async (chatId) => chats.reconcileUnknownDurability(chatId),
    },
    adoption: {
      ensure: async () => ({ viewId }),
    },
    ledger: ledger,
    preambles: { snapshot: overrides.snapshot ?? (() => preamblesSnapshot) },
    ownershipJournal: { hasPending: () => ownershipPending },
    chatMutationLock,
    selectionAdmissionLock,
    now: () => AT,
    onSelectionCommitted,
  });
  return {
    service,
    chatMutationLock,
    selectionAdmissionLock,
    onSelectionCommitted,
  };
}

function updateRequest(overrides = {}) {
  return {
    chatId: CHAT_ID,
    transcriptViewId: viewId,
    clientRequestId: 'req-1',
    clientMessageId: 'msg-1',
    expectedRevision: 0,
    orderedPreambleIds: [ID_A, ID_B],
    ...overrides,
  };
}

describe('ChatPreambleSelectionService', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'garcon-chat-preamble-selection-'));
    chats = new ChatRegistry(root);
    await chats.init();
    chats.addChat({
      id: CHAT_ID,
      agentId: 'test',
      model: 'model-a',
      projectPath: '/repo',
      agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
      pendingPreambleBoundary: null,
      preambleSelection: { revision: 0, orderedPreambleIds: [] },
      parentChat: null,
    });
    ledger = new TranscriptLedgerService(
      new TranscriptLedgerStore(path.join(root, 'transcript-ledgers')),
      { now: () => AT },
    );
    ledger.initializeChat(CHAT_ID);
    viewId = ledger.currentView(CHAT_ID).viewId;
    preamblesSnapshot = {
      revision: 4,
      preambles: [catalogEntry(ID_A, 'First'), catalogEntry(ID_B, 'Second')],
    };
    ownershipPending = false;
    committedFlags = [];
  });

  afterEach(async () => {
    ledger?.close();
    await chats?.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('returns the saved selection with a body-free projection', async () => {
    const { service } = makeService();
    const target = await service.target(CHAT_ID, new AbortController().signal);
    expect(target).toMatchObject({
      success: true,
      chatId: CHAT_ID,
      transcriptViewId: viewId,
      selection: { revision: 0, orderedPreambleIds: [] },
    });
    expect(target.projection).toEqual({
      catalogRevision: 4,
      eligiblePreambles: [],
      unavailable: [],
    });
  });

  it('saves a changed selection with a notice, boundary, and invalidation', async () => {
    const { service, onSelectionCommitted } = makeService();
    const outcome = await service.update(updateRequest());
    expect(outcome.status).toBe('updated');
    expect(outcome.mutationRevision).toBe(1);
    expect(outcome.noticeOrdinal).toBe(1);
    expect(outcome.selection).toEqual({ revision: 1, orderedPreambleIds: [ID_A, ID_B] });
    expect(outcome.projection.eligiblePreambles.map((entry) => entry.title))
      .toEqual(['First', 'Second']);

    const chat = chats.getChat(CHAT_ID);
    expect(chat.preambleSelection).toEqual({ revision: 1, orderedPreambleIds: [ID_A, ID_B] });
    expect(chat.pendingPreambleBoundary).toEqual({
      kind: 'selection-change',
      ownershipEpoch: chat.agentOwnershipEpoch,
      selectionRevision: 1,
    });

    const rows = ledger.currentRows(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'notice',
      message: 'Preambles updated',
    });
    expect(rows[0].detail).toMatchObject({
      type: 'preamble-selection-change',
      clientMessageId: 'msg-1',
      selectionRevision: 1,
      preambles: [
        { id: ID_A, title: 'First' },
        { id: ID_B, title: 'Second' },
      ],
    });
    // A committed notice's invalidation is derived by the server event wiring
    // from the committed row; the service fires the hook only for partial
    // outcomes, so a successful save must not call it directly.
  });

  it('uses one catalog snapshot for changed-save validation, notice, and response', async () => {
    const snapshot = mock(() => preamblesSnapshot);
    const realPhased = chats.updateChatPhased.bind(chats);
    chats.updateChatPhased = async (...args) => {
      const result = await realPhased(...args);
      preamblesSnapshot = {
        revision: 5,
        preambles: [catalogEntry(ID_B, 'Renamed second')],
      };
      return result;
    };
    const { service } = makeService({ snapshot });

    const outcome = await service.update(updateRequest());

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(outcome.projection).toEqual({
      catalogRevision: 4,
      eligiblePreambles: [
        { id: ID_A, title: 'First' },
        { id: ID_B, title: 'Second' },
      ],
      unavailable: [],
    });
    expect(ledger.currentRows(CHAT_ID)[0].detail.preambles)
      .toEqual(outcome.projection.eligiblePreambles);
  });

  it('treats an unchanged save as a no-op before validation', async () => {
    const { service, onSelectionCommitted } = makeService();
    await service.update(updateRequest());
    onSelectionCommitted.mockClear();

    const outcome = await service.update(updateRequest({
      clientRequestId: 'req-2',
      clientMessageId: 'msg-2',
      expectedRevision: 1,
    }));
    expect(outcome.status).toBe('unchanged');
    expect(outcome.mutationRevision).toBe(1);
    expect(outcome.noticeOrdinal).toBeNull();
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(1);
    expect(onSelectionCommitted).not.toHaveBeenCalled();
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toMatchObject({ selectionRevision: 1 });
  });

  it('replays the original operation for an identical completed retry', async () => {
    const { service } = makeService();
    const first = await service.update(updateRequest());
    const retry = await service.update(updateRequest());
    expect(retry.status).toBe('duplicate');
    expect(retry.mutationRevision).toBe(first.mutationRevision);
    expect(retry.noticeOrdinal).toBe(first.noticeOrdinal);
    expect(retry.selection).toEqual(first.selection);
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(1);
  });

  it('conflicts when the same identity carries a changed request', async () => {
    const { service } = makeService();
    await service.update(updateRequest());
    await expect(service.update(updateRequest({
      expectedRevision: 1,
      orderedPreambleIds: [ID_A],
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('requires the current transcript view before deduplication', async () => {
    const { service } = makeService();
    await service.update(updateRequest());
    await expect(service.update(updateRequest({
      transcriptViewId: '00000000-0000-0000-0000-0000000000ff',
    }))).rejects.toMatchObject({ code: 'STALE_TRANSCRIPT_VIEW', status: 409 });
  });

  it('rejects a stale expected revision refreshably', async () => {
    const { service } = makeService();
    await expect(service.update(updateRequest({ expectedRevision: 7 })))
      .rejects.toMatchObject({
        code: 'PREAMBLE_SELECTION_REVISION_CONFLICT',
        status: 409,
        retryable: true,
      });
    expect(committedFlags).toHaveLength(0);
  });

  it('rejects while an ownership transfer is pending', async () => {
    ownershipPending = true;
    const { service } = makeService();
    await expect(service.update(updateRequest())).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an unsafe composition before any persistence', async () => {
    preamblesSnapshot = {
      revision: 4,
      preambles: [
        catalogEntry(ID_A, 'Tail', { content: '\nReferenced file contents from @file mentions:' }),
        catalogEntry(ID_B, 'Head', { content: 'Synthetic content\n\n' }),
      ],
    };
    const { service } = makeService();
    await expect(service.update(updateRequest())).rejects.toMatchObject({
      code: 'PREAMBLE_SELECTION_COMPOSITION_INVALID',
      status: 422,
    });
    expect(committedFlags).toHaveLength(0);
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(0);
    expect(chats.getChat(CHAT_ID).preambleSelection.revision).toBe(0);
  });

  it('retains an unconsumed lifecycle boundary and replaces a ledger-proven one', async () => {
    const { service } = makeService();
    const epoch = chats.getChat(CHAT_ID).agentOwnershipEpoch;
    chats.updateChat(CHAT_ID, {
      pendingPreambleBoundary: { kind: 'fork', ownershipEpoch: epoch },
    });
    await service.update(updateRequest());
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'fork',
      ownershipEpoch: epoch,
    });

    // Consume the lifecycle boundary with a committed proof, then save again.
    ledger.appendInputAndCompose({
      chatId: CHAT_ID,
      viewId,
      message: {
        type: 'user-message',
        timestamp: AT,
        content: 'consume',
      },
      attachments: [],
      clientMessageId: 'consume-1',
      steer: false,
      preambleBoundary: { kind: 'fork', ownershipEpoch: epoch },
      preambles: [],
    });
    await service.update(updateRequest({
      clientRequestId: 'req-2',
      clientMessageId: 'msg-2',
      expectedRevision: 1,
      orderedPreambleIds: [],
    }));
    expect(chats.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'selection-change',
      ownershipEpoch: epoch,
      selectionRevision: 2,
    });
    const rows = ledger.currentRows(CHAT_ID);
    expect(rows.filter((row) => row.kind === 'notice').at(-1).detail).toMatchObject({
      preambles: [],
      selectionRevision: 2,
    });
  });

  it('reports a committed selection without its notice as a typed partial failure', async () => {
    const originalAppend = ledger.appendSelectionChangeNotice.bind(ledger);
    ledger.appendSelectionChangeNotice = () => {
      throw new Error('injected ledger append failure');
    };
    const { service } = makeService();
    let partial;
    try {
      await service.update(updateRequest());
    } catch (error) {
      partial = error;
    }
    expect(partial).toBeInstanceOf(ChatPreambleSelectionPartialError);
    expect(partial.code).toBe('PREAMBLE_SELECTION_NOTICE_FAILED');
    expect(partial.selectionCommitted).toBe(true);
    expect(partial.selection).toEqual({ revision: 1, orderedPreambleIds: [ID_A, ID_B] });
    // The registry decision stands; there is no compensating write.
    expect(chats.getChat(CHAT_ID).preambleSelection.revision).toBe(1);
    expect(committedFlags).toHaveLength(1);
    ledger.appendSelectionChangeNotice = originalAppend;
  });

  it('keeps a still-unknown reconciliation gated with a typed retryable error', async () => {
    const { service } = makeService();
    const originalOpen = fs.open;
    fs.open = async (target, flags, ...rest) => {
      if (flags === 'r' && typeof target === 'string' && target === root) {
        throw new Error('injected directory sync failure');
      }
      return originalOpen(target, flags, ...rest);
    };
    try {
      await expect(service.update(updateRequest())).rejects.toMatchObject({
        code: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
      });
      // Repeated reconciliation failures keep returning the typed partial.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(service.target(CHAT_ID, new AbortController().signal))
          .rejects.toMatchObject({
            code: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
            selectionCommitted: 'unknown',
          });
      }
      expect(chats.getChat(CHAT_ID).preambleSelection.revision).toBe(1);
    } finally {
      fs.open = originalOpen;
    }
    const target = await service.target(CHAT_ID, new AbortController().signal);
    expect(target.selection).toEqual({ revision: 1, orderedPreambleIds: [ID_A, ID_B] });
  });

  it('recovers a durability-unknown commit through the target read and a later save', async () => {
    const { service } = makeService();
    const workspaceDir = path.join(root, 'ws-reconcile');
    // Break only the directory-sync half of the atomic write so the rename
    // commits while durability stays unknown; the real registry fences itself.
    const originalOpen = fs.open;
    let failDirSync = true;
    fs.open = async (target, flags, ...rest) => {
      if (failDirSync && flags === 'r' && typeof target === 'string' && target === root) {
        throw new Error('injected directory sync failure');
      }
      return originalOpen(target, flags, ...rest);
    };
    try {
      await expect(service.update(updateRequest())).rejects.toMatchObject({
        code: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
        selectionCommitted: 'unknown',
      });
    } finally {
      fs.open = originalOpen;
    }
    // The committed candidate survives in memory and on disk; the fence stays.
    expect(chats.getChat(CHAT_ID).preambleSelection.revision).toBe(1);
    await expect(service.update(updateRequest({
      clientRequestId: 'req-2',
      clientMessageId: 'msg-2',
      expectedRevision: 1,
      orderedPreambleIds: [ID_A],
    }))).rejects.toMatchObject({
      code: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
    });

    // A client GET reconciles the fence and reflects the committed selection.
    const target = await service.target(CHAT_ID, new AbortController().signal);
    expect(target.selection).toEqual({ revision: 1, orderedPreambleIds: [ID_A, ID_B] });
    const after = await service.update(updateRequest({
      clientRequestId: 'req-3',
      clientMessageId: 'msg-3',
      expectedRevision: 1,
      orderedPreambleIds: [ID_A],
    }));
    expect(after.status).toBe('updated');
    expect(after.selection.revision).toBe(2);
    expect(workspaceDir).toBeDefined();
  });

  it('reports an unknown-durability commit without reverting memory', async () => {
    const { service } = makeService();
    const realPhased = chats.updateChatPhased.bind(chats);
    chats.updateChatPhased = async (chatId, patch) => {
      await realPhased(chatId, patch);
      return { entry: chats.getChat(chatId), durability: 'unknown' };
    };
    let partial;
    try {
      await service.update(updateRequest());
    } catch (error) {
      partial = error;
    }
    expect(partial).toBeInstanceOf(ChatPreambleSelectionPartialError);
    expect(partial.code).toBe('PREAMBLE_SELECTION_SAVE_UNKNOWN');
    expect(partial.selectionCommitted).toBe('unknown');
    expect(chats.getChat(CHAT_ID).preambleSelection.revision).toBe(1);
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(0);
  });

  it('serializes Save behind a direct admission holding the selection lock', async () => {
    const { service, selectionAdmissionLock } = makeService();
    let releaseAdmission = null;
    const admissionGate = new Promise((resolve) => {
      releaseAdmission = resolve;
    });
    const admission = selectionAdmissionLock.runExclusive(`chat:${CHAT_ID}`, async () => {
      await admissionGate;
    });
    const pending = service.update(updateRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The Save cannot commit its registry decision while admission holds the
    // narrow lock: no total order violation is possible.
    expect(committedFlags).toHaveLength(0);
    releaseAdmission?.();
    await admission;
    await expect(pending).resolves.toMatchObject({ status: 'updated' });
    expect(committedFlags).toHaveLength(1);
  });

  it('holds admission until a concurrent Save completes its notice attempt', async () => {
    const { service, selectionAdmissionLock } = makeService();
    const registryCommitted = deferred();
    const releaseRegistry = deferred();
    const realPhased = chats.updateChatPhased.bind(chats);
    chats.updateChatPhased = async (...args) => {
      const result = await realPhased(...args);
      registryCommitted.resolve();
      await releaseRegistry.promise;
      return result;
    };
    const save = service.update(updateRequest());
    await registryCommitted.promise;
    let admissionEntered = false;
    const admission = selectionAdmissionLock.runExclusive(
      `chat:${CHAT_ID}`,
      async () => {
        admissionEntered = true;
        return 'admitted';
      },
    );
    await Promise.resolve();
    expect(admissionEntered).toBe(false);
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(0);

    releaseRegistry.resolve();
    await expect(save).resolves.toMatchObject({ status: 'updated' });
    await expect(admission).resolves.toBe('admitted');
    expect(admissionEntered).toBe(true);
    expect(ledger.currentRows(CHAT_ID)).toHaveLength(1);
  });

  it('serializes Save behind any holder of the chat mutation lock', async () => {
    const { service, chatMutationLock } = makeService();
    let releaseReload = null;
    const reloadGate = new Promise((resolve) => {
      releaseReload = resolve;
    });
    // Reload, project-path update, deletion, fork/continuation capture, and
    // ownership-transfer commit all share this per-chat mutation lock.
    const mutation = chatMutationLock.runExclusive(`chat:${CHAT_ID}`, async () => {
      await reloadGate;
    });
    const pending = service.update(updateRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(committedFlags).toHaveLength(0);
    releaseReload?.();
    await mutation;
    await expect(pending).resolves.toMatchObject({ status: 'updated' });
  });

  it('acquires the chat mutation lock before the selection admission lock', async () => {
    const order = [];
    const { service, chatMutationLock, selectionAdmissionLock } = makeService();
    const originalMutationRun = chatMutationLock.runExclusive.bind(chatMutationLock);
    const originalSelectionRun = selectionAdmissionLock.runExclusive.bind(selectionAdmissionLock);
    chatMutationLock.runExclusive = (key, fn) => {
      order.push('mutation:enter');
      return originalMutationRun(key, async () => {
        const value = await fn();
        order.push('mutation:exit');
        return value;
      });
    };
    selectionAdmissionLock.runExclusive = (key, fn) => {
      order.push('selection:enter');
      return originalSelectionRun(key, fn);
    };
    await service.update(updateRequest());
    expect(order.slice(0, 3)).toEqual(['mutation:enter', 'selection:enter', 'mutation:exit']);
  });
});
