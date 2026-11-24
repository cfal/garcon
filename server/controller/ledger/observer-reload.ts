import { isDeepStrictEqual } from 'node:util';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { ChatReloadProgress } from '../../../common/ws-events.js';
import { DomainError } from '../../common/domain-error.js';
import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { AgentDirectory } from '../agents/directory.js';
import type { ChatRegistryEntry } from '../chats/registry-contracts.js';
import type { IChatRegistry } from '../chats/store.js';
import type { NativeChildObserverService } from '../chats/native-child-observer-service.js';
import type { ChatExecutionService } from '../chat-execution/chat-execution-coordinator.js';
import type { TranscriptSnapshotReservation } from '../chat-execution/types.js';
import type { LedgerRowDraft, TranscriptView } from './contracts.js';
import { LedgerFencedError, TranscriptViewNotInitializedError } from './errors.js';
import { observationNotice, observedDrafts } from './observed-drafts.js';
import type { TranscriptReloadOptions } from './reload.js';
import type { TranscriptLedgerService } from './service.js';

export interface ObserverReloadOptions {
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly ledger: TranscriptLedgerService;
  readonly integrations: Pick<AgentDirectory, 'require'>;
  readonly observers: Pick<NativeChildObserverService, 'capture' | 'retireChat'>;
  readonly execution: Pick<ChatExecutionService, 'reserveTranscriptSnapshot' | 'releaseTranscriptSnapshot'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly now?: () => string;
}

export function reloadOutcomeUnknown(cause: unknown): DomainError {
  return new DomainError('RELOAD_OUTCOME_UNKNOWN',
    'Reload may have replaced the transcript. Refresh the current history before trying again.', 503, false, { cause });
}

export class ObserverReloadService {
  constructor(private readonly options: ObserverReloadOptions) {}

  async reload(chatId: string, { signal = new AbortController().signal, onProgress = () => {} }: TranscriptReloadOptions = {}): Promise<TranscriptView> {
    const entry = this.#observer(chatId);
    const owner = this.#matchingOwner(entry);
    const chatIds = [chatId, ...(owner ? [owner] : [])].sort();
    return this.options.chatMutationLock.runExclusiveMany(chatIds.map(id => `chat:${id}`), async () => {
      this.#assertOrigin(chatId, entry);
      if (owner !== this.#matchingOwner(entry)) throw sourceChanged();
      const reservations: TranscriptSnapshotReservation[] = [];
      let promoted = false;
      try {
        signal.throwIfAborted();
        for (const id of chatIds) reservations.push(this.options.execution.reserveTranscriptSnapshot(id));
        const view = await this.#reloadReserved(chatId, entry, signal, onProgress);
        promoted = true;
        return view;
      } catch (error) {
        if ((error instanceof DomainError || error instanceof AgentIntegrationError) && error.code === 'SESSION_BUSY') {
          throw new DomainError('CHAT_RUNNING', 'Wait for the native source to become idle before reloading.', 409, true, { cause: error });
        }
        throw error;
      } finally {
        let failure: unknown;
        for (const reservation of reservations.reverse()) {
          try { await this.options.execution.releaseTranscriptSnapshot(reservation); }
          catch (error) { failure = error; }
        }
        if (failure) throw promoted ? reloadOutcomeUnknown(failure) : failure;
      }
    });
  }

  async #reloadReserved(chatId: string, entry: ChatRegistryEntry, signal: AbortSignal,
    onProgress: (progress: ChatReloadProgress) => void): Promise<TranscriptView> {
    const { ledger, observers } = this.options;
    const current = ledger.existingCurrentView(chatId);
    if (!current) throw new TranscriptViewNotInitializedError(chatId);
    const watermark = ledger.highWatermark(chatId);
    const capture = observers.capture(chatId);
    const integration = this.options.integrations.require(entry.agentId, entry.executorId);
    const reader = integration.nativeChildObservation;
    if (!reader) throw new DomainError('HISTORY_LOAD_FAILED', 'Native subagent history is unavailable.', 422, false);
    const expectedScope = { ...integration.producers.scope };
    const steps = new EventLoopSteps('native child history reload');
    const drafts: LedgerRowDraft[] = [];
    let hadGap = false;
    let staging: TranscriptView | null = null;
    try {
      onProgress({ phase: 'reading', rows: 0 });
      for await (const batch of reader.loadHistory({ child: entry.nativeObservation!.child, signal }, { expectedScope })) {
        for (const row of batch) {
          signal.throwIfAborted();
          const mapped = observedDrafts([row]);
          drafts.push(...mapped.drafts);
          hadGap ||= mapped.hadGap;
          if (steps.due) await steps.next();
        }
        onProgress({ phase: 'reading', rows: drafts.length });
        if (steps.due) await steps.next();
      }
      signal.throwIfAborted();
      const now = this.options.now?.() ?? new Date().toISOString();
      if (hadGap) drafts.push(observationNotice({ type: 'native-child-gap' }, now));
      drafts.push(observationNotice({ type: 'native-history-snapshot' }, now));
      onProgress({ phase: 'saving', rows: drafts.length });
      staging = await ledger.stageView(chatId, drafts, 1);
      this.#assertOrigin(chatId, entry);
      const latest = ledger.highWatermark(chatId);
      if (latest.viewId !== watermark.viewId || latest.ordinal !== watermark.ordinal
        || observers.capture(chatId) !== capture) throw sourceChanged();
      return this.#promote(chatId, current, staging);
    } catch (error) {
      if (error instanceof LedgerFencedError) observers.retireChat(chatId);
      if (staging && !(error instanceof DomainError && error.code === 'RELOAD_OUTCOME_UNKNOWN')) {
        try { await ledger.discardStagingView(chatId, staging.viewId); }
        catch (cleanupError) {
          if (!(cleanupError instanceof LedgerFencedError)) throw cleanupError;
          observers.retireChat(chatId);
        }
      }
      throw error;
    }
  }

  #promote(chatId: string, previous: TranscriptView, staging: TranscriptView): TranscriptView {
    const { ledger, observers } = this.options;
    let replacement: TranscriptView;
    try {
      replacement = ledger.replaceCurrentView(chatId, previous.viewId, staging.viewId);
    } catch (error) {
      let current: TranscriptView | null;
      try { current = ledger.existingCurrentView(chatId); }
      catch {
        observers.retireChat(chatId);
        throw reloadOutcomeUnknown(error);
      }
      if (current?.viewId !== staging.viewId) {
        if (error instanceof LedgerFencedError) {
          observers.retireChat(chatId);
          throw reloadOutcomeUnknown(error);
        }
        throw error;
      }
      replacement = current;
    }
    observers.retireChat(chatId);
    return replacement;
  }

  #observer(chatId: string): ChatRegistryEntry {
    const entry = this.options.registry.getChat(chatId);
    if (!entry) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
    if (!entry.nativeObservation) throw new DomainError('HISTORY_LOAD_FAILED', 'Chat is not a native subagent observation.', 422, false);
    return entry;
  }

  #assertOrigin(chatId: string, expected: ChatRegistryEntry): void {
    const current = this.#observer(chatId);
    if (current.agentId !== expected.agentId || current.executorId !== expected.executorId
      || current.agentOwnershipEpoch !== expected.agentOwnershipEpoch
      || !isDeepStrictEqual(current.nativeObservation, expected.nativeObservation)) throw sourceChanged();
  }

  #matchingOwner(entry: ChatRegistryEntry): string | null {
    const origin = entry.nativeObservation!;
    const source = this.options.registry.getChat(origin.sourceChatId);
    return source && !source.nativeObservation && source.agentId === entry.agentId
      && effectiveExecutorId(source.executorId) === effectiveExecutorId(entry.executorId)
      && source.agentOwnershipEpoch === origin.sourceOwnershipEpoch
      && source.agentSessionId === origin.sourceAgentSessionId ? origin.sourceChatId : null;
  }
}

function sourceChanged(): DomainError {
  return new DomainError('HISTORY_LOAD_FAILED', 'The captured history changed during Reload. Try again.', 409, true);
}
