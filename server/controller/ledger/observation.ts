import type { AgentProducedRow } from '@garcon/server-agent-interface';
import { isNativeChildStatus, type NativeChildStatus } from '../../../common/chat-observation.js';
import type { LedgerRowDraft, TranscriptCommitEvent } from './contracts.js';
import type { TranscriptLedgerStore } from './store.js';
import { TranscriptSinkClosedError } from './errors.js';
import { observationNotice, observedDrafts } from './observed-drafts.js';

export interface TranscriptObservationLease {
  readonly closed: boolean;
  publishRows(rows: readonly AgentProducedRow[]): void;
  publishStatus(status: NativeChildStatus): void;
  publishGap(): void;
  close(): void;
  onClosed(listener: () => void): () => void;
}

export class ObservationWriters {
  readonly #leases = new Map<string, ObservationLease>();

  constructor(private readonly options: {
    store: Pick<TranscriptLedgerStore, 'existingCurrentView' | 'append'>;
    hasProducer(chatId: string): boolean;
    notify(event: TranscriptCommitEvent): void;
    now(): string;
  }) {}

  has(chatId: string): boolean { return this.#leases.has(chatId); }
  close(chatId: string): void { this.#leases.get(chatId)?.close(); }
  closeAll(): void { for (const lease of this.#leases.values()) lease.close(); }

  open(chatId: string): TranscriptObservationLease {
    if (this.has(chatId) || this.options.hasProducer(chatId)) throw new TypeError('Transcript writer is already open');
    const view = this.options.store.existingCurrentView(chatId);
    if (!view) throw new TypeError('Observation requires an existing transcript view');
    const lease = new ObservationLease(drafts => {
      if (this.#leases.get(chatId) !== lease
        || this.options.store.existingCurrentView(chatId)?.viewId !== view.viewId) throw new TranscriptSinkClosedError();
      const rows = this.options.store.append(chatId, view.viewId, drafts);
      this.options.notify({ type: 'rows', chatId, viewId: view.viewId, rows });
    }, () => {
      if (this.#leases.get(chatId) === lease) this.#leases.delete(chatId);
    }, this.options.now);
    this.#leases.set(chatId, lease);
    return lease;
  }
}

export class ObservationLease implements TranscriptObservationLease {
  #closed = false;
  #gapReported = false;
  #lastStatus: NativeChildStatus | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly append: (rows: readonly LedgerRowDraft[]) => void,
    private readonly onClose: () => void,
    private readonly now: () => string,
  ) {}

  get closed(): boolean { return this.#closed; }

  publishRows(rows: readonly AgentProducedRow[]): void {
    this.#assertOpen();
    const { drafts, hadGap } = observedDrafts(rows);
    if (hadGap && !this.#gapReported) drafts.push(observationNotice({ type: 'native-child-gap' }, this.now()));
    this.#publish(drafts);
    if (hadGap) this.#gapReported = true;
  }

  publishStatus(status: NativeChildStatus): void {
    this.#assertOpen();
    if (!isNativeChildStatus(status)) { this.publishGap(); return; }
    if (status === this.#lastStatus) return;
    this.#publish([observationNotice({ type: 'native-child-status', status }, this.now())]);
    this.#lastStatus = status;
  }

  publishGap(): void {
    this.#assertOpen();
    if (this.#gapReported) return;
    this.#publish([observationNotice({ type: 'native-child-gap' }, this.now())]);
    this.#gapReported = true;
  }

  onClosed(listener: () => void): () => void {
    if (this.#closed) listener();
    else this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* Observation cleanup cannot fail its parent. */ }
    }
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new TranscriptSinkClosedError();
  }

  #publish(rows: readonly LedgerRowDraft[]): void {
    this.#assertOpen();
    if (!rows.length) return;
    try { this.append(rows); }
    catch (error) { this.close(); throw error; }
  }
}
