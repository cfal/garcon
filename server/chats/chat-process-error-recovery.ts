import { ErrorMessage } from '../../common/chat-types.js';
import type { AppendedChatViewMessages, ChatViewStore } from './chat-view-store.js';
import type { ChatNativeReloader, NativeReloadResult } from './chat-native-reload.js';
import type { PendingUserInputServiceContract } from './pending-user-input-service.js';

export const PROCESS_ERROR_RELOAD_FAILED_NOTICE =
  'The process died. Reloading chat history failed.';

export type ChatProcessErrorRecoveryResult =
  | { kind: 'generation-reset'; reload: NativeReloadResult }
  | {
    kind: 'fallback-appended';
    appended: AppendedChatViewMessages;
    reloadError: unknown;
  }
  | {
    kind: 'unavailable';
    reloadError: unknown;
    fallbackError: unknown;
  };

type ProcessErrorViews = Pick<
  ChatViewStore,
  'appendToCurrentOrProvisional'
>;

type ProcessErrorReloader = Pick<ChatNativeReloader, 'reloadFromNative'>;

type ProcessErrorPendingInputs = Pick<
  PendingUserInputServiceContract,
  'reconcileRetainedHistory' | 'markUnpersistedFailed'
>;

export class ChatProcessErrorRecovery {
  #views: ProcessErrorViews;
  #reloader: ProcessErrorReloader;
  #pendingInputs: ProcessErrorPendingInputs;

  constructor(
    views: ProcessErrorViews,
    reloader: ProcessErrorReloader,
    pendingInputs: ProcessErrorPendingInputs,
  ) {
    this.#views = views;
    this.#reloader = reloader;
    this.#pendingInputs = pendingInputs;
  }

  async recover(chatId: string, message: string): Promise<ChatProcessErrorRecoveryResult> {
    let reload: NativeReloadResult;
    try {
      reload = await this.#reloader.reloadFromNative(chatId, 'process-error', message);
    } catch (reloadError) {
      let appended: AppendedChatViewMessages;
      try {
        appended = await this.#views.appendToCurrentOrProvisional(chatId, [
          new ErrorMessage(
            new Date().toISOString(),
            PROCESS_ERROR_RELOAD_FAILED_NOTICE,
          ),
        ]);
      } catch (fallbackError) {
        await this.#settlePendingInputs(chatId);
        return { kind: 'unavailable', reloadError, fallbackError };
      }
      await this.#settlePendingInputs(chatId);
      return { kind: 'fallback-appended', appended, reloadError };
    }
    await this.#settlePendingInputs(chatId);
    return { kind: 'generation-reset', reload };
  }

  async #settlePendingInputs(chatId: string): Promise<void> {
    try {
      await this.#pendingInputs.reconcileRetainedHistory(chatId);
    } finally {
      this.#pendingInputs.markUnpersistedFailed(chatId);
    }
  }
}
