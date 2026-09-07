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
  persistenceError?: unknown,
): Promise<void> {
  if (!preparation) return;
  try {
    await preparation.rollback();
  } catch (error) {
    input.logger.warn('Project-path preparation rollback failed', {
      chatId: input.chatId,
      agentId: input.agentId,
      error: errorMessage(error),
      ...(persistenceError === undefined
        ? {}
        : { persistenceError: errorMessage(persistenceError) }),
    });
    throw new DomainError(
      'PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN',
      'The agent did not confirm the project path rollback',
      504,
      true,
      {
        cause: persistenceError === undefined
          ? error
          : new AggregateError([persistenceError, error], 'Project path persistence and rollback failed'),
      },
    );
  }
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
    throw projectPathPreparationError(error);
  }

  let updated: T | null;
  try {
    updated = await input.persist(
      preparation?.nativeSession !== undefined
        ? preparation.nativeSession
        : input.fallbackNativeSession,
    );
  } catch (error) {
    await rollbackPreparation(preparation, input, error);
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

function projectPathPreparationError(error: unknown): DomainError {
  if (!(error instanceof AgentIntegrationError)) {
    return new DomainError('CHAT_NOT_IDLE', errorMessage(error), 409, true);
  }

  switch (error.code) {
    case 'TRANSCRIPT_UNAVAILABLE':
    case 'SESSION_NOT_FOUND':
      return new DomainError(
        'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
        error.message,
        409,
        error.retryable,
      );
    case 'PROJECT_PATH_DESTINATION_REJECTED':
      return new DomainError(
        'PROJECT_PATH_DESTINATION_REJECTED',
        error.message,
        422,
        error.retryable,
      );
    case 'OPERATION_UNSUPPORTED':
      return new DomainError(
        'PROJECT_PATH_UPDATE_UNSUPPORTED',
        error.message,
        422,
        error.retryable,
      );
    case 'TIMEOUT':
      return new DomainError(
        'PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN',
        error.message,
        504,
        error.retryable,
      );
    case 'SESSION_BUSY':
      return new DomainError('CHAT_NOT_IDLE', error.message, 409, error.retryable);
    case 'UNAVAILABLE':
    case 'BINARY_NOT_FOUND':
      return new DomainError(
        'PROJECT_PATH_UPDATE_FAILED',
        error.message,
        503,
        error.retryable,
      );
    default:
      return new DomainError(
        'PROJECT_PATH_UPDATE_FAILED',
        error.message,
        502,
        error.retryable,
      );
  }
}
