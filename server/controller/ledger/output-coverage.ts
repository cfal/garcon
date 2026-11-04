import type { ExecutionFailureCertainty } from '../../../common/automation.js';

export interface OutputCoverageWatch {
  readonly gapped: AbortSignal;
  release(): void;
}

export class TranscriptOutputCoverage {
  readonly #gappedRuns = new Set<string>();
  readonly #watches = new Map<string, Set<AbortController>>();

  watch(chatId: string): OutputCoverageWatch {
    const controller = new AbortController();
    let watches = this.#watches.get(chatId);
    if (!watches) this.#watches.set(chatId, watches = new Set());
    watches.add(controller);
    return { gapped: controller.signal, release: () => {
      watches.delete(controller);
      if (!watches.size) this.#watches.delete(chatId);
    } };
  }

  markGap(chatId: string): void {
    this.#gappedRuns.add(chatId);
    // Binding gaps cannot identify the producing turn, including late output.
    for (const watch of this.#watches.get(chatId) ?? []) watch.abort();
  }

  beginRun(chatId: string): void { this.#gappedRuns.delete(chatId); }

  endRun(chatId: string, origin: 'provider' | 'core', certainty: ExecutionFailureCertainty): 'complete' | 'gapped' | 'unknown' {
    if (this.#gappedRuns.delete(chatId)) return 'gapped';
    return origin === 'provider' || certainty === 'not-started' ? 'complete' : 'unknown';
  }

  closeChat(chatId: string): void { this.#gappedRuns.delete(chatId); }

  close(): void {
    for (const watches of this.#watches.values()) for (const watch of watches) watch.abort();
    this.#watches.clear();
    this.#gappedRuns.clear();
  }
}
