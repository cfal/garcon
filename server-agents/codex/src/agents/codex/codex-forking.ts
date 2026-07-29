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
  readonly resolveProfile: (request: AgentForkRequest) => Promise<CodexHistoryProfile | null>;
  readonly forkPaginatedWhole: (
    request: AgentForkRequest,
  ) => Promise<AgentStartedSession | null>;
}

export function createCodexForking(options: CodexForkingOptions): AgentForking {
  return {
    supportsAtMessage: true,
    supportsWhileRunning: options.legacy.supportsWhileRunning,
    async fork(request) {
      request.admission.signal.throwIfAborted();
      const profile = await options.resolveProfile(request);
      if (!profile) return options.legacy.fork(request);
      if (profile.mode === 'legacy') return options.legacy.fork(request);
      if (request.point) throw paginatedForkUnsupported('fork-at-message');

      try {
        const forked = await options.forkPaginatedWhole(request);
        if (forked) return { kind: 'materialized', session: forked };
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

export function isCodexThreadNotFound(error: unknown): boolean {
  // Codex 0.144.6 maps absent stored threads and rollout paths to INVALID_REQUEST.
  // https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/app-server/src/request_processors/thread_processor.rs#L4174-L4184
  return error instanceof CodexAppServerRpcError
    && error.code === -32600
    && (
      /^no rollout found for thread id [0-9a-f-]{36}$/i.test(error.message)
      || /^failed to resolve rollout path `[^`]+`: file does not exist$/.test(error.message)
    );
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
