import { AgentIntegrationError, type AgentLogger } from '@garcon/server-agent-interface';
import { CodexAppServerRpcError } from './client.js';
import type { CodexTurnError } from './protocol.js';
import type {
  FinishSessionOptions,
  RunningCodexSession,
  RunningStatus,
} from './runtime-session-state.js';

export const GOAL_TURN_START_TIMEOUT_MS = 30_000;
export const MAX_GOAL_CONTROL_DELIVERY_TRANSITIONS = 8;
export const MAX_CAPACITY_RETRIES = 3;
export const CAPACITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function denialResponseForRequest(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  return { decision: 'denied' };
}

export function humanizeCodexAppServerError(error: unknown): string {
  if (error instanceof AgentIntegrationError) return error.message;
  const raw = String((error as Error)?.message || error || '');
  if (/not found|ENOENT.*codex|spawn codex/i.test(raw)) {
    return 'Codex CLI is not installed or not in PATH. Install it with: npm i -g @openai/codex';
  }
  if (/authentication|unauthorized|401|api.?key/i.test(raw)) {
    return 'Codex authentication failed. Run "codex" in your terminal to sign in.';
  }
  if (/rate.?limit|429/i.test(raw)) {
    return 'Codex rate limit exceeded. Please wait a moment and try again.';
  }
  if (/model.*not.?found|invalid.*model|does not exist/i.test(raw)) {
    return 'Codex model not available. Check your model selection or Codex configuration.';
  }
  if (/ECONNREFUSED|ENOTFOUND|network|timeout|ETIMEDOUT/i.test(raw)) {
    return 'Codex could not connect to the API. Check your network connection.';
  }
  return `Codex error: ${raw}`;
}

export function isUtilityOverload(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError && error.code === -32001) return true;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (record.code === -32001) return true;
  return /overloaded/i.test(String((error as Error)?.message || error || ''));
}

export function isCapacityError(error: CodexTurnError | null | undefined): boolean {
  return error?.codexErrorInfo === 'serverOverloaded'
    || /selected model is at capacity/i.test(error?.message ?? '');
}

export function isActiveTurnConflictError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '');
  return /turn already active|active turn.*(?:exists|in progress)|cannot start.*active turn/i.test(message);
}

export function mergeFinishOptions(
  current: FinishSessionOptions | null,
  next: FinishSessionOptions,
): FinishSessionOptions {
  return {
    failedMessage: next.failedMessage ?? current?.failedMessage,
    aborted: Boolean(next.aborted || current?.aborted),
    emitFinishedOnAbort: Boolean(next.emitFinishedOnAbort || current?.emitFinishedOnAbort),
  };
}

export function hasTerminalPendingFinish(session: RunningCodexSession): boolean {
  return Boolean(session.pendingFinish?.failedMessage || session.pendingFinish?.aborted);
}

export function isTerminalSessionStatus(status: RunningStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

export function isActiveSessionStatus(status: RunningStatus): boolean {
  return status === 'running' || status === 'interrupting' || status === 'completing';
}

export function hasActiveGoalContinuation(session: RunningCodexSession): boolean {
  return session.managesGoalLifecycle
    && Boolean(session.activeTurnId || session.goal?.status === 'active');
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
