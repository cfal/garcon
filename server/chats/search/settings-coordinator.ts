import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import type { SettingsStore } from '../../settings/store.js';
import type { TranscriptSearchController } from './controller.js';

const SETTINGS_LOCK_KEY = 'transcript-search-setting';

export class TranscriptSearchSettingsError extends Error {
  constructor(
    public readonly code: 'TRANSCRIPT_SEARCH_ENABLE_FAILED' | 'TRANSCRIPT_SEARCH_CLEANUP_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptSearchSettingsError';
  }
}

export class TranscriptSearchSettingsCoordinator {
  readonly #settings: SettingsStore;
  readonly #controller: TranscriptSearchController;
  readonly #lock = new KeyedPromiseLock();

  constructor(settings: SettingsStore, controller: TranscriptSearchController) {
    this.#settings = settings;
    this.#controller = controller;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#lock.runExclusive(SETTINGS_LOCK_KEY, async () => {
      const current = this.#settings.getFeatureSettings().transcriptSearch.enabled;
      if (current === enabled) {
        if (!enabled) {
          await this.#disableAndDelete();
        } else {
          try {
            await this.#controller.start();
          } catch (error) {
            throw new TranscriptSearchSettingsError(
              'TRANSCRIPT_SEARCH_ENABLE_FAILED',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return;
      }
      if (enabled) {
        try {
          await this.#controller.start();
          await this.#settings.setTranscriptSearchEnabled(true);
        } catch (error) {
          await this.#controller.disableAndDelete().catch(() => undefined);
          throw new TranscriptSearchSettingsError(
            'TRANSCRIPT_SEARCH_ENABLE_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      await this.#settings.setTranscriptSearchEnabled(false);
      await this.#disableAndDelete();
    });
  }

  async #disableAndDelete(): Promise<void> {
    try {
      await this.#controller.disableAndDelete();
    } catch (error) {
      throw new TranscriptSearchSettingsError(
        'TRANSCRIPT_SEARCH_CLEANUP_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
