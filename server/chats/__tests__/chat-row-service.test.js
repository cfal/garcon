import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatRowService } from '../chat-row-service.ts';
import { DomainError } from '../../lib/domain-error.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { transcriptViewId } from '../../ledger/contracts.ts';
import { LedgerFencedError } from '../../ledger/errors.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';

const CHAT_ID = '1787000000000000';
const AT = '2026-08-18T00:00:00.000Z';

describe('ChatRowService', () => {
  it('lazily acquires the target view and appends one idempotent row', async () => {
    await withService(async ({ service, ledger, adoption }) => {
      const target = await service.target(CHAT_ID, new AbortController().signal);
      const input = request({ transcriptViewId: target.transcriptViewId });

      const first = await service.add(input, new AbortController().signal);
      const retry = await service.add(input, new AbortController().signal);

      expect(adoption).toHaveBeenCalledTimes(3);
      expect(first).toMatchObject({
        commandType: 'chat-row-add',
        status: 'appended',
        ordinal: 1,
        type: 'error',
        timestamp: AT,
      });
      expect(retry).toMatchObject({ status: 'duplicate', ordinal: 1, timestamp: AT });
      expect(ledger.currentRows(CHAT_ID)).toMatchObject([{
        kind: 'notice',
        message: 'durable error',
        detail: {
          type: 'cli-row',
          clientMessageId: 'message-1',
          presentation: 'error',
          title: 'Release validation',
        },
      }]);

      await expect(service.add(
        request({ title: 'Different title' }),
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
      await expect(service.add(
        request({ type: 'info' }),
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
      const info = ledger.appendChatRow({
        chatId: CHAT_ID,
        viewId: ledger.currentView(CHAT_ID).viewId,
        clientMessageId: 'message-2',
        type: 'info',
        content: 'healthy information',
      });
      expect(info).toMatchObject({
        inserted: true,
        row: { detail: { presentation: 'info' } },
      });
    });
  });

  it('rejects a stale target without retargeting the row', async () => {
    await withService(async ({ service, ledger }) => {
      const original = ledger.currentView(CHAT_ID);
      const staging = ledger.stageView(CHAT_ID, [], 1, transcriptViewId('replacement-view'));
      ledger.replaceCurrentView(CHAT_ID, original.viewId, staging.viewId);

      await expect(service.add(
        request({ transcriptViewId: original.viewId }),
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'STALE_TRANSCRIPT_VIEW', status: 409, retryable: false });
      expect(ledger.currentRows(CHAT_ID)).toEqual([]);
    });
  });

  it('checks the pending handoff and abort signal immediately before mutation', async () => {
    await withService(async ({ service, ledger, ownershipJournal }) => {
      ownershipJournal.pending = true;
      await expect(service.add(request(), new AbortController().signal))
        .rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING', retryable: true });

      ownershipJournal.pending = false;
      const abort = new AbortController();
      abort.abort(new Error('cancelled'));
      await expect(service.add(request(), abort.signal)).rejects.toThrow('cancelled');
      expect(ledger.currentRows(CHAT_ID)).toEqual([]);
    });
  });

  it('rechecks registry membership after waiting for the shared mutation lock', async () => {
    await withService(async ({ service, ledger, registry, lock }) => {
      const held = deferred();
      const entered = deferred();
      const blocker = lock.runExclusive(`chat:${CHAT_ID}`, async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const adding = service.add(request(), new AbortController().signal);
      await Promise.resolve();
      registry.entry = null;
      held.resolve();

      await blocker;
      await expect(adding).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 });
      expect(ledger.currentRows(CHAT_ID)).toEqual([]);
    });
  });

  it('contains fenced-ledger diagnostics and exposes a fixed wire error', async () => {
    const cause = Object.assign(new Error('/private/workspace/ledger.sqlite'), {
      name: 'SqliteError',
      code: 'SQLITE_CORRUPT',
    });
    const warn = mock(() => undefined);
    const service = new ChatRowService({
      registry: { getChat: () => ({ id: CHAT_ID }) },
      adoption: { ensure: async () => ({ viewId: transcriptViewId('view-1') }) },
      ledger: {
        appendChatRow() {
          throw new LedgerFencedError(CHAT_ID, { cause });
        },
      },
      ownershipJournal: { hasPending: () => false },
      chatMutationLock: new KeyedPromiseLock(),
      logger: { warn },
    });

    await expect(service.add(request({
      title: 'Private release title',
      content: 'Private release detail',
    }), new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({
        code: 'TRANSCRIPT_UNAVAILABLE',
        message: 'Chat transcript is unavailable.',
        status: 422,
        retryable: false,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      'Chat row mutation encountered a fenced transcript ledger.',
      { causeName: 'SqliteError', causeCode: 'SQLITE_CORRUPT' },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CHAT_ID);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Private release title');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Private release detail');
  });
});

async function withService(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-chat-row-service-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => AT,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => AT });
  ledger.initializeChat(CHAT_ID);
  const registry = { entry: { id: CHAT_ID }, getChat() { return this.entry; } };
  const adoption = mock(async () => ledger.currentView(CHAT_ID));
  const ownershipJournal = {
    pending: false,
    hasPending() { return this.pending; },
  };
  const lock = new KeyedPromiseLock();
  const service = new ChatRowService({
    registry,
    adoption: { ensure: adoption },
    ledger,
    ownershipJournal,
    chatMutationLock: lock,
    logger: { warn: () => undefined },
  });
  try {
    await run({ service, ledger, registry, adoption, ownershipJournal, lock });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function request(overrides = {}) {
  return {
    clientRequestId: 'request-1',
    clientMessageId: 'message-1',
    chatId: CHAT_ID,
    transcriptViewId: 'view-1',
    type: 'error',
    title: 'Release validation',
    content: 'durable error',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}
