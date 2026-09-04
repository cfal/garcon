import {
  AgentIntegrationError,
  type AgentNativeFork,
  type AgentNativeForkRequest,
  type AgentEstablishedSession,
} from '@garcon/server-agent-interface';
import { missingNativePoint } from '@garcon/server-agent-common/forking/jsonl-forking';
import { CodexAppServerRpcError } from './app-server/client.js';
import type { CodexHistoryProfile } from './history-profile.js';
import { codexTurnIdFromEntryId } from './message-source-identity.js';

export interface CodexForkingOptions {
  readonly journal: AgentNativeFork;
  readonly resolveProfile: (request: {
    readonly source: AgentNativeForkRequest['source'];
    // Presence decides missing-source strictness; whole and point forks pass
    // their own point shapes.
    readonly point: object | null;
    readonly signal: AbortSignal;
  }) => Promise<CodexHistoryProfile | null>;
  readonly forkPaginatedWhole: (
    request: AgentNativeForkRequest,
  ) => Promise<AgentEstablishedSession | null>;
  // Forks through the named turn, inclusive. The app-server rejects an in-progress or unknown
  // turn, which maps to the same typed refusal the JSONL point path produces.
  readonly forkPaginatedPoint: (
    request: AgentNativeForkRequest,
    lastTurnId: string,
  ) => Promise<AgentEstablishedSession | null>;
}

export function createCodexForking(options: CodexForkingOptions): AgentNativeFork {
  return {
    async fork(request) {
      request.admission.signal.throwIfAborted();
      const profile = await options.resolveProfile({
        source: request.source,
        point: request.providerMeta,
        signal: request.admission.signal,
      });
      if (!profile) return options.journal.fork(request);
      if (profile.mode === 'legacy') return options.journal.fork(request);
      if (request.providerMeta) return forkPaginatedAtTurn(options, request);

      try {
        const forked = await options.forkPaginatedWhole(request);
        if (forked) return { kind: 'materialized', session: forked };
        throw paginatedForkUnsupported();
      } catch (error) {
        if (isUnsupportedPaginatedFork(error)) throw paginatedForkUnsupported();
        throw error;
      }
    },
    discard(session, signal) {
      return options.journal.discard(session, signal);
    },
  };
}

// Paginated history forks at turn granularity, so the anchor row's source identity names the turn
// to fork through. An identity the provider has not correlated yet cannot name one and refuses as
// unsettled, matching the JSONL point path.
async function forkPaginatedAtTurn(
  options: CodexForkingOptions,
  request: AgentNativeForkRequest,
): Promise<ReturnType<AgentNativeFork['fork']>> {
  const lastTurnId = codexTurnIdFromEntryId(request.providerMeta?.entryId);
  if (!lastTurnId) throw missingNativePoint();
  try {
    const forked = await options.forkPaginatedPoint(request, lastTurnId);
    if (forked) return { kind: 'materialized', session: forked };
    throw paginatedForkUnsupported();
  } catch (error) {
    if (isUnsettledPaginatedForkPoint(error)) throw missingNativePoint();
    if (isUnsupportedPaginatedFork(error)) throw paginatedForkUnsupported();
    throw error;
  }
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

// The app-server rejects a lastTurnId naming an in-progress turn or a turn absent from native
// history, either as INVALID_REQUEST. Both mean the selected point is not a settled native
// position yet, so they share the JSONL point path's typed retryable refusal.
// https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/thread-store/src/local/paginated_fork.rs#L114-L120
// https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/thread-store/src/local/thread_history/turn_lookup.rs#L47-L49
function isUnsettledPaginatedForkPoint(error: unknown): boolean {
  return error instanceof CodexAppServerRpcError
    && error.code === -32600
    && (/identifies an in-progress turn/.test(error.message)
      || /^turn not found: /.test(error.message));
}

function paginatedForkUnsupported(): AgentIntegrationError {
  return new AgentIntegrationError(
    'OPERATION_UNSUPPORTED',
    'Codex paginated history cannot be forked by the installed Codex CLI',
    false,
    { operation: 'fork', historyMode: 'paginated', provider: 'codex' },
  );
}
