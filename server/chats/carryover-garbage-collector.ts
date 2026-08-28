import { createLogger } from '../lib/log.js';
import type { AgentOwnershipJournal } from './agent-ownership-journal.js';
import type { CarryOverTranscriptStore } from './carryover-transcript-store.js';
import type { IChatRegistry } from './store.js';

const logger = createLogger('chats:carryover-gc');
const CARRYOVER_GC_DELAY_MS = 1_000;

export class CarryOverGarbageCollector {
  #scheduled = false;
  #defer: (callback: () => void) => void;

  constructor(private readonly deps: {
    readonly registry: Pick<IChatRegistry, 'listAllChats'>;
    readonly journal: Pick<AgentOwnershipJournal, 'roots'>;
    readonly store: Pick<CarryOverTranscriptStore, 'cleanupTemporary' | 'sweep'>;
  }, options: { readonly defer?: (callback: () => void) => void } = {}) {
    this.#defer = options.defer ?? ((callback) => {
      const timer = setTimeout(callback, CARRYOVER_GC_DELAY_MS);
      timer.unref?.();
    });
  }

  async initialize(): Promise<void> {
    const roots = this.#roots();
    const removedTemporaryDirectories = await this.deps.store.cleanupTemporary(roots);
    const result = await this.deps.store.sweep(() => this.#roots());
    logger.info('startup sweep complete', { ...result, removedTemporaryDirectories });
  }

  schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#defer(() => {
      this.#scheduled = false;
      void this.sweep().catch((error) => {
        logger.warn('scheduled sweep failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  async sweep(): Promise<void> {
    const result = await this.deps.store.sweep(() => this.#roots());
    logger.info('sweep complete', result);
  }

  #roots(): ReadonlySet<string> {
    const roots = new Set(this.deps.journal.roots());
    for (const entry of Object.values(this.deps.registry.listAllChats())) {
      for (const ref of entry.carryOverSegments) {
        if (ref.storedMessageCount > 0) roots.add(ref.id);
      }
    }
    return roots;
  }
}
