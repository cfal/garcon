import {
  AgentIntegrationError,
  type AgentLogger,
  type AgentNativeSessionRef,
  type AgentProjectPathUpdatePreparation,
} from '@garcon/server-agent-interface';
import { DomainError } from '../lib/domain-error.js';
import { errorMessage } from '../lib/errors.js';

async function rollbackPreparation(
  preparation: AgentProjectPathUpdatePreparation | void,
  input: {
    readonly chatId: string;
    readonly agentId: string;
    readonly logger: AgentLogger;
  },
): Promise<void> {
  if (!preparation) return;
  await preparation.rollback().catch((error) => {
    input.logger.warn('Project-path preparation rollback failed', {
      chatId: input.chatId,
      agentId: input.agentId,
      error: errorMessage(error),
    });
  });
}

export async function runProjectPathUpdateTransaction<T>(input: {
  readonly chatId: string;
  readonly agentId: string;
  readonly fallbackNativeSession: AgentNativeSessionRef | null | undefined;
  readonly prepare: () => Promise<AgentProjectPathUpdatePreparation | void>;
  readonly persist: (
    nativeSession: AgentNativeSessionRef | null | undefined,
  ) => Promise<T | null>;
  readonly logger: AgentLogger;
}): Promise<T | null> {
  let preparation: AgentProjectPathUpdatePreparation | void;
  try {
    preparation = await input.prepare();
  } catch (error) {
    if (
      error instanceof AgentIntegrationError
      && error.code === 'TRANSCRIPT_UNAVAILABLE'
    ) {
      throw new DomainError(
        'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
        error.message,
        409,
        error.retryable,
      );
    }
    throw new DomainError(
      'CHAT_NOT_IDLE',
      errorMessage(error),
      409,
      true,
    );
  }

  let updated: T | null;
  try {
    updated = await input.persist(
      preparation ? preparation.nativeSession : input.fallbackNativeSession,
    );
  } catch (error) {
    await rollbackPreparation(preparation, input);
    throw error;
  }
  if (!updated) {
    await rollbackPreparation(preparation, input);
    return null;
  }

  if (preparation) {
    await preparation.commit().catch((error) => {
      input.logger.warn('Project-path preparation cleanup failed', {
        chatId: input.chatId,
        agentId: input.agentId,
        error: errorMessage(error),
      });
    });
  }
  return updated;
}
