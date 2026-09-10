import { AGENT_START_PROGRESS_CONTENT, type AgentStartProgressPhase } from '../../common/agent-start-progress.js';
import type { TranscriptCommitEvent, TranscriptLedgerService } from '../ledger/service.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('agent-start-progress');

export class AgentStartProgress {
  readonly #viewId: TranscriptViewId;
  #closed = false;
  #lastPhase: AgentStartProgressPhase | null = null;
  readonly #unsubscribe: () => void;

  constructor(
    private readonly ledger: Pick<TranscriptLedgerService, 'existingCurrentView' | 'appendNotice' | 'subscribe'>,
    private readonly chatId: string,
    private readonly turnId: string,
    private readonly signal: AbortSignal,
  ) {
    const view = ledger.existingCurrentView(chatId);
    if (!view) throw new Error('Accepted child has no transcript view');
    this.#viewId = view.viewId;
    this.#unsubscribe = ledger.subscribe(this.#onTranscriptCommit);
    signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  report(phase: AgentStartProgressPhase, explanation?: string): void {
    if (this.#closed || this.#lastPhase === phase) return;
    if (this.signal.aborted && phase !== 'interrupted') return;
    if (this.ledger.existingCurrentView(this.chatId)?.viewId !== this.#viewId) return;
    this.ledger.appendNotice(this.chatId, this.#viewId, {
      title: 'Agent startup',
      content: [AGENT_START_PROGRESS_CONTENT[phase], explanation].filter(Boolean).join(' '),
      detail: { type: 'agent-start-progress', phase },
    });
    this.#lastPhase = phase;
    if (phase === 'started' || phase === 'failed' || phase === 'interrupted') this.dispose();
  }

  fail(error: unknown): void {
    const phase = this.signal.aborted ? 'interrupted' : 'failed';
    const explanation = error instanceof DomainError ? error.message : undefined;
    this.#finishFailure(phase, explanation);
  }

  #finishFailure(phase: 'failed' | 'interrupted', explanation?: string): void {
    try {
      this.report(phase, explanation);
    } catch (noticeError) {
      logger.warn('Startup outcome notice could not be recorded', {
        chatId: this.chatId,
        errorType: noticeError instanceof Error ? noticeError.name : typeof noticeError,
      });
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    this.#closed = true;
    this.signal.removeEventListener('abort', this.#onAbort);
    this.#unsubscribe();
  }

  readonly #onTranscriptCommit = (event: TranscriptCommitEvent): void => {
    if (event.chatId !== this.chatId) return;
    if (event.type === 'view-replaced' && event.previousViewId === this.#viewId) {
      this.dispose();
      return;
    }
    if (event.type !== 'run-ended' || event.viewId !== this.#viewId || event.runId !== this.turnId) return;
    switch (event.row.outcome) {
      case 'failed':
        this.fail(undefined);
        break;
      case 'interrupted':
        this.#finishFailure('interrupted');
        break;
      default:
        this.dispose();
    }
  };

  readonly #onAbort = (): void => { this.fail(this.signal.reason); };
}
