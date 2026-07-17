import { ErrorMessage } from '../../common/chat-types.js';
import type { AppendedChatViewMessages, ChatViewStore } from './chat-view-store.js';
import type { ChatNativeReloader, NativeReloadResult } from './chat-native-reload.js';
import type {
  PendingUserInputCohort,
  PendingUserInputServiceContract,
} from './pending-user-input-service.js';

export const PROCESS_ERROR_RELOAD_FAILED_NOTICE =
  'The process died. Reloading chat history failed.';

interface PendingSettlementResult {
  settlementError?: unknown;
}

export type ChatProcessErrorRecoveryResult =
  | ({ kind: 'generation-reset'; reload: NativeReloadResult } & PendingSettlementResult)
  | ({
    kind: 'fallback-appended';
    appended: AppendedChatViewMessages;
    reloadError: unknown;
  } & PendingSettlementResult)
  | ({
    kind: 'unavailable';
    reloadError: unknown;
    fallbackError: unknown;
  } & PendingSettlementResult);

type ProcessErrorViews = Pick<
  ChatViewStore,
  'appendToCurrentOrProvisional'
>;

type ProcessErrorReloader = Pick<ChatNativeReloader, 'reloadFromNative'>;

type ProcessErrorPendingInputs = Pick<
  PendingUserInputServiceContract,
  'captureCohort' | 'settleRetainedCohort'
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
    const cohort = this.#pendingInputs.captureCohort(chatId);
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
        const settlementError = this.#settlementError(cohort);
        return {
          kind: 'unavailable',
          reloadError,
          fallbackError,
          ...(settlementError === undefined ? {} : { settlementError }),
        };
      }
      const settlementError = this.#settlementError(cohort);
      return {
        kind: 'fallback-appended',
        appended,
        reloadError,
        ...(settlementError === undefined ? {} : { settlementError }),
      };
    }
    const settlementError = this.#settlementError(cohort);
    return {
      kind: 'generation-reset',
      reload,
      ...(settlementError === undefined ? {} : { settlementError }),
    };
  }

  #settlementError(cohort: PendingUserInputCohort): unknown | undefined {
    try {
      this.#pendingInputs.settleRetainedCohort(cohort);
      return undefined;
    } catch (error) {
      return error;
    }
  }
}
