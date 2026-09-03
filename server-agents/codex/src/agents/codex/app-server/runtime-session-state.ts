import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { CodexSkillDiscovery } from '../slash-command-discovery.js';
import type { cleanupOwnedGoalAttachments } from './goal-files.js';
import type { GoalAttachmentOperations } from './goal-attachment-operations.js';
import type { NativePathDiscoveryRefreshLimiterOptions } from './native-path-discovery-refresh.js';
import type { CodexOperation } from './operation-routes.js';
import type { CodexAppServerClient, CodexAppServerClientOptions } from './client.js';
import type {
  CodexThreadGoal,
  JsonRpcNotification,
  JsonRpcServerRequest,
} from './protocol.js';
import type { CodexTurnItemLedger } from './turn-item-ledger.js';
import type { CodexThreadSettingsTarget } from './request-builders.js';

export type RunningStatus = (
  'running' | 'interrupting' | 'completing' | 'completed' | 'failed' | 'aborted'
);
export type FinishSessionOptions = {
  failedMessage?: string;
  aborted?: boolean;
  emitFinishedOnAbort?: boolean;
};
export type GoalCommandOptions = {
  keepSession: boolean;
  goalSynchronized?: boolean;
  propagateDeliveryFailure?: boolean;
};

interface TurnStartWaiter {
  resolve: (turnId: string) => void;
  reject: (error: Error) => void;
}

export interface ThreadSettingsWaiter {
  readonly target: CodexThreadSettingsTarget;
  readonly timeout: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
}

export class TurnStartWaitCancelledError extends Error {}

export type BufferedClientEvent =
  | { type: 'notification'; notification: JsonRpcNotification }
  | { type: 'serverRequest'; request: JsonRpcServerRequest };

export interface RunningCodexSession {
  chatId: string;
  threadId: string;
  nativePath: string | null;
  codexHome: string | null;
  client: CodexAppServerClient;
  activeTurnId: string | null;
  status: RunningStatus;
  permissionMode: PermissionMode;
  startedAt: string;
  cleanupAttachments?: () => Promise<void>;
  turnStartWaiters: Set<TurnStartWaiter>;
  goal: CodexThreadGoal | null;
  managesGoalLifecycle: boolean;
  completedGoalTurn: boolean;
  ignoredGoalClears: number;
  activeInputChain: Promise<void>;
  goalAttachments: GoalAttachmentOperations;
  activeDeliveryReservations: number;
  pendingFinish: FinishSessionOptions | null;
  pendingFinishOperation: CodexOperation | null;
  liveCodeModeResultToolIds: Map<string, string>;
  turnItems: CodexTurnItemLedger;
  capacityRetryCount: number;
  turnAttemptGeneration: number;
  pendingCapacityFailure: { turnId: string; message: string } | null;
  sourceOperation: CodexOperation;
  nextTurnOperation: CodexOperation | null;
  goalOperation: CodexOperation | null;
  lastTurnOperation: CodexOperation | null;
  turnRoutes: Map<string, CodexOperation>;
  terminalTurnIds: Set<string>;
  superseded: boolean;
  confirmedThreadSettings: CodexThreadSettingsTarget;
  pendingThreadSettings: ThreadSettingsWaiter | null;
  threadSettingsUpdateChain: Promise<void>;
  configurationFenced: boolean;
}

export interface CodexAppServerRuntimeOptions {
  createClient?: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  materializationTimeoutMs?: number;
  settingsUpdateTimeoutMs?: number;
  capacityRetryDelaysMs?: readonly number[];
  capacityRetryDelay?: (delayMs: number) => Promise<void>;
  nativePathDiscoveryRefresh?: NativePathDiscoveryRefreshLimiterOptions;
  logger?: AgentLogger;
  skillDiscovery?: CodexSkillDiscovery;
  cleanupOwnedGoalAttachments?: typeof cleanupOwnedGoalAttachments;
}

export function waitForTurnStart(
  sessions: ReadonlyMap<string, RunningCodexSession>,
  session: RunningCodexSession,
  timeoutMs: number,
): Promise<string> {
  if (session.activeTurnId) return Promise.resolve(session.activeTurnId);
  return registerTurnStartWaiter(
    sessions,
    session,
    timeoutMs,
    () => true,
    `timed out waiting for Codex goal turn to start after ${Math.round(timeoutMs / 1000)} seconds`,
  );
}

export function waitForDifferentTurnStart(
  sessions: ReadonlyMap<string, RunningCodexSession>,
  session: RunningCodexSession,
  previousTurnId: string | null,
  timeoutMs: number,
): Promise<string> {
  if (session.activeTurnId && session.activeTurnId !== previousTurnId) {
    return Promise.resolve(session.activeTurnId);
  }
  return registerTurnStartWaiter(
    sessions,
    session,
    timeoutMs,
    (turnId) => turnId !== previousTurnId,
    `timed out waiting for the next Codex turn after ${Math.round(timeoutMs / 1000)} seconds`,
  );
}

function registerTurnStartWaiter(
  sessions: ReadonlyMap<string, RunningCodexSession>,
  session: RunningCodexSession,
  timeoutMs: number,
  accepts: (turnId: string) => boolean,
  timeoutMessage: string,
): Promise<string> {
  if (sessions.get(session.threadId) !== session) {
    return Promise.reject(new TurnStartWaitCancelledError('Codex session is no longer active'));
  }
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (action: () => void) => {
      clearTimeout(timeout);
      session.turnStartWaiters.delete(waiter);
      action();
    };
    const waiter: TurnStartWaiter = {
      resolve: (turnId) => {
        if (accepts(turnId)) settle(() => resolve(turnId));
      },
      reject: (error) => settle(() => reject(error)),
    };
    timeout = setTimeout(() => waiter.reject(new Error(timeoutMessage)), timeoutMs);
    session.turnStartWaiters.add(waiter);
  });
}

export function cancelTurnStartWaiters(session: RunningCodexSession, message: string): void {
  const error = new TurnStartWaitCancelledError(message);
  for (const waiter of [...session.turnStartWaiters]) waiter.reject(error);
}

export function sessionForClientThread(
  sessions: ReadonlyMap<string, RunningCodexSession>,
  client: CodexAppServerClient,
  threadId: string,
): RunningCodexSession | null {
  const session = sessions.get(threadId);
  return session?.client === client ? session : null;
}

export function adoptTurn(
  session: RunningCodexSession,
  turnId: string,
  operation: CodexOperation,
): boolean {
  if (session.turnRoutes.has(turnId)) return false;
  session.turnRoutes.set(turnId, operation);
  session.activeTurnId = turnId;
  if (session.nextTurnOperation === operation) session.nextTurnOperation = null;
  return true;
}

export function sourceForClientThread(
  sources: ReadonlyMap<CodexAppServerClient, RunningCodexSession>,
  client: CodexAppServerClient,
  threadId: string,
): RunningCodexSession | null {
  const session = sources.get(client);
  return session?.threadId === threadId ? session : null;
}

export function sourceForClientTurn(
  sources: ReadonlyMap<CodexAppServerClient, RunningCodexSession>,
  client: CodexAppServerClient,
  threadId: string,
  turnId: string,
): RunningCodexSession | null {
  const session = sourceForClientThread(sources, client, threadId);
  return session?.turnRoutes.has(turnId) ? session : null;
}
