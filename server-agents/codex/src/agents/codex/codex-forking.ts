import {
  AgentIntegrationError,
  type AgentForkRequest,
  type AgentForking,
  type AgentStartedSession,
} from '@garcon/server-agent-interface';
import { CodexAppServerRpcError } from './app-server/client.js';
import type { CodexHistoryProfile } from './history-profile.js';

export interface CodexForkingOptions {
  readonly legacy: AgentForking;
  readonly resolveProfile: (request: AgentForkRequest) => Promise<CodexHistoryProfile>;
  readonly forkPaginatedWhole: (
    request: AgentForkRequest,
  ) => Promise<AgentStartedSession | null>;
}

export function createCodexForking(options: CodexForkingOptions): AgentForking {
  return {
    supportsAtMessage: true,
    supportsAtMessageWhileRunning: options.legacy.supportsAtMessageWhileRunning,
    async fork(request) {
      request.admission.signal.throwIfAborted();
      const profile = await options.resolveProfile(request);
      if (profile.mode === 'legacy') return options.legacy.fork(request);
      if (request.point) throw paginatedForkUnsupported('fork-at-message');

      try {
        const forked = await options.forkPaginatedWhole(request);
        if (forked) return forked;
        throw paginatedForkUnsupported('fork');
      } catch (error) {
        if (isUnsupportedPaginatedFork(error)) throw paginatedForkUnsupported('fork');
        throw error;
      }
    },
    discard(session, signal) {
      return options.legacy.discard(session, signal);
    },
  };
}

function isUnsupportedPaginatedFork(error: unknown): boolean {
  if (error instanceof AgentIntegrationError) {
    return error.code === 'OPERATION_UNSUPPORTED';
  }
  if (error instanceof CodexAppServerRpcError) {
    return error.code === -32601
      || /paginated_threads|paginated threads|not supported/i.test(error.message);
  }
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return value.code === -32601
    && typeof value.message === 'string'
    && /paginated_threads|paginated threads|not supported/i.test(value.message);
}

function paginatedForkUnsupported(operation: 'fork' | 'fork-at-message'): AgentIntegrationError {
  return new AgentIntegrationError(
    'OPERATION_UNSUPPORTED',
    operation === 'fork-at-message'
      ? 'Codex paginated history cannot be forked at a message'
      : 'Codex paginated history cannot be forked by the installed Codex CLI',
    false,
    { operation, historyMode: 'paginated', provider: 'codex' },
  );
}
