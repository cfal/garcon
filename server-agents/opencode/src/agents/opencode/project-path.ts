import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentProjectPathUpdates,
} from '@garcon/server-agent-interface';
import { OpenCodeTimeoutError } from './request-control.js';
import { OpenCodeSdkResultError } from './sdk-result.js';

// OpenCode 1.18.29 flattens mismatch and missing-session errors into fixed messages.
// https://github.com/anomalyco/opencode/blob/47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7/packages/opencode/src/server/routes/instance/httpapi/handlers/control-plane.ts#L30-L36
const DESTINATION_PROJECT_MISMATCH = 'Destination directory belongs to another project';
const SESSION_NOT_FOUND_PREFIX = 'Session not found:';
const MISSING_ENDPOINT_STATUSES = new Set([404, 405, 501]);

interface OpenCodeProjectPathRuntime {
  moveSession(agentSessionId: string, directory: string, signal: AbortSignal): Promise<void>;
}

export function createOpenCodeProjectPathUpdates(input: {
  readonly runtime: OpenCodeProjectPathRuntime;
  readonly sessionId: (chat: AgentChatReference) => string | null;
}): AgentProjectPathUpdates {
  return {
    async prepare(request) {
      request.signal.throwIfAborted();
      const sessionId = input.sessionId(request.chat);
      if (!sessionId) return;

      try {
        await input.runtime.moveSession(sessionId, request.nextProjectPath, request.signal);
      } catch (error) {
        throw projectPathUpdateError(error);
      }
      request.signal.throwIfAborted();

      return {
        commit: async () => undefined,
        rollback: () => input.runtime.moveSession(
          sessionId,
          request.chat.projectPath,
          new AbortController().signal,
        ),
      };
    },
  };
}

function projectPathUpdateError(error: unknown): AgentIntegrationError {
  if (error instanceof AgentIntegrationError) return error;
  if (error instanceof OpenCodeTimeoutError) {
    return new AgentIntegrationError(
      'TIMEOUT',
      'OpenCode did not confirm the project path update',
      true,
    );
  }
  if (error instanceof OpenCodeSdkResultError) {
    if (error.message === DESTINATION_PROJECT_MISMATCH) {
      return new AgentIntegrationError(
        'PROJECT_PATH_DESTINATION_REJECTED',
        error.message,
        false,
      );
    }
    if (error.message.startsWith(SESSION_NOT_FOUND_PREFIX)) {
      return new AgentIntegrationError('SESSION_NOT_FOUND', error.message, false);
    }
    if (error.status !== null && MISSING_ENDPOINT_STATUSES.has(error.status)) {
      return new AgentIntegrationError(
        'OPERATION_UNSUPPORTED',
        'This OpenCode version does not support project path updates',
        false,
      );
    }
    return new AgentIntegrationError(
      error.status !== null && error.status >= 500 ? 'UNAVAILABLE' : 'PROVIDER_FAILURE',
      error.message,
      error.status === null || error.status >= 500,
    );
  }
  return new AgentIntegrationError('UNAVAILABLE', errorMessage(error), true);
}
