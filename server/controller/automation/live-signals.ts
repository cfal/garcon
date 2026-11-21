import type { AutomationSignal, AutomationSignalDecision, AutomationTurnKey } from '../../../common/automation.js';
import type { LedgerProviderRow, TranscriptViewId } from '../ledger/contracts.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { workflowSignalCandidates } from './signal-envelope.js';

const MAX_PENDING_SIGNALS = 128;
const MAX_PENDING_BYTES = 512 * 1024;

export type AcceptAutomationSignal = (signal: AutomationSignal) => AutomationSignalDecision | Promise<AutomationSignalDecision>;

export class LiveSignals {
  #tail = Promise.resolve();
  #pending = 0;
  #bytes = 0;
  #fault: string | null = null;

  constructor(
    private readonly transcripts: Pick<TranscriptLedgerService, 'existingCurrentView' | 'appendNotice'>,
    private readonly key: AutomationTurnKey,
    private readonly allowed: () => boolean,
    private readonly accept: AcceptAutomationSignal,
  ) {}

  collect(viewId: TranscriptViewId, rows: readonly LedgerProviderRow[]): void {
    if (!this.#current(viewId) || this.#fault) return;
    for (const row of rows) {
      if (row.message.type !== 'assistant-message' || row.message.questions) continue;
      let candidates: ReturnType<typeof workflowSignalCandidates>;
      try {
        candidates = workflowSignalCandidates(row.message.content);
      } catch {
        this.#fault = 'Workflow signal parsing did not settle.';
        return;
      }
      for (const [index, candidate] of candidates.entries()) {
        const bytes = candidate.kind === 'emit' ? Buffer.byteLength(candidate.payload.text) + Buffer.byteLength(candidate.name) : 0;
        if (this.#pending >= MAX_PENDING_SIGNALS || this.#bytes + bytes > MAX_PENDING_BYTES) {
          this.#fault = 'Workflow signal processing exceeded its pending limit.';
          return;
        }
        const source = { transcriptViewId: viewId, ordinal: row.ordinal, index };
        this.#pending++;
        this.#bytes += bytes;
        this.#tail = this.#tail.then(async () => {
          if (!this.#current(viewId) || this.#fault) return;
          const result = await this.accept({ key: this.key, source, candidate });
          const rejection = result?.kind === 'rejected' ? result.message : candidate.kind === 'invalid' ? candidate.reason : null;
          if (rejection !== null
            && this.transcripts.existingCurrentView(this.key.chatId)?.viewId === viewId) {
            this.transcripts.appendNotice(this.key.chatId, viewId, {
              title: 'Workflow signal rejected',
              content: rejection.slice(0, 1000).toWellFormed().trim() || 'The workflow rejected this signal.',
            });
          }
        }).catch(() => {
          this.#fault ??= 'Workflow signal acceptance did not settle.';
        }).finally(() => {
          this.#pending--;
          this.#bytes -= bytes;
        });
      }
    }
  }

  async drain(): Promise<string | null> {
    await this.#tail;
    return this.#fault;
  }

  #current(viewId: TranscriptViewId): boolean {
    return this.allowed() && this.transcripts.existingCurrentView(this.key.chatId)?.viewId === viewId;
  }
}
