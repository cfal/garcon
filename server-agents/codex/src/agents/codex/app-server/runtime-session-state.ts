import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { CodexStartRequest } from '../runtime-types.js';
import type { CodexSkillDiscovery } from '../slash-command-discovery.js';
import type { NativePathDiscoveryRefreshLimiterOptions } from './native-path-discovery-refresh.js';
import type { CodexOperation } from './operation-routes.js';
import type { CodexAppServerClient, CodexAppServerClientOptions } from './client.js';
import type {
  JsonRpcNotification,
  JsonRpcServerRequest,
} from './protocol.js';
import type { CodexTurnItemLedger } from './turn-item-ledger.js';
import {
  codexThreadSettingsTarget,
  type CodexConfirmedThreadSettings,
  type CodexThreadSettingsTarget,
} from './request-builders.js';

export type RunningStatus = (
  'running' | 'interrupting' | 'completing' | 'completed' | 'failed' | 'aborted'
);
export type FinishSessionOptions = {
  failedMessage?: string;
  aborted?: boolean;
  emitFinishedOnAbort?: boolean;
};

export interface ThreadSettingsWaiter {
  readonly target: CodexThreadSettingsTarget;
  readonly timeout: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
}

export class CodexSessionActivationFailure extends Error {
  constructor(
    readonly originalError: unknown,
    readonly shutdown: Promise<void>,
  ) {
    super('Codex session activation failed');
  }
}

export type BufferedClientEvent =
  | { type: 'notification'; notification: JsonRpcNotification }
  | { type: 'serverRequest'; request: JsonRpcServerRequest };

export interface RunningCodexSession {
  chatId: string;
  threadId: string;
  nativePath: string | null;
  codexHome: string | null;
  client: CodexAppServerClient;
  runtimeIdentity: string;
  activeTurnId: string | null;
  status: RunningStatus;
  permissionMode: PermissionMode;
  startedAt: string;
  cleanupAttachments?: () => Promise<void>;
  activeInputChain: Promise<void>;
  activeDeliveryReservations: number;
  pendingFinish: FinishSessionOptions | null;
  pendingFinishOperation: CodexOperation | null;
  interruptAcknowledgement: Promise<boolean> | null;
  terminalWaiters: Set<() => void>;
  liveCodeModeResultToolIds: Map<string, string>;
  turnItems: CodexTurnItemLedger;
  capacityRetryCount: number;
  turnAttemptGeneration: number;
  pendingCapacityFailure: { turnId: string; message: string } | null;
  sourceOperation: CodexOperation;
  nextTurnOperation: CodexOperation | null;
  lastTurnOperation: CodexOperation | null;
  turnRoutes: Map<string, CodexOperation>;
  terminalTurnIds: Set<string>;
  superseded: boolean;
  // Tracks omitted Default intent because Codex snapshots only the effective concrete effort.
  providerOwnsReasoningEffort: boolean;
  confirmedThreadSettings: CodexConfirmedThreadSettings;
  pendingThreadSettings: ThreadSettingsWaiter | null;
  threadSettingsUpdateChain: Promise<void>;
  configurationFenced: boolean;
  // Wall-clock stamp taken when the session finishes while its source stays
  // retained; drives the idle reclamation sweep for retained writers.
  idleSince: number | null;
}

export function providerOwnsReasoningEffort(
  request: Pick<CodexStartRequest, 'model' | 'permissionMode' | 'thinkingMode'>,
): boolean {
  return codexThreadSettingsTarget(request).effort === null;
}

export function recordExplicitReasoningEffort(
  session: RunningCodexSession,
  request: Pick<CodexStartRequest, 'model' | 'permissionMode' | 'thinkingMode'>,
): void {
  if (!providerOwnsReasoningEffort(request)) session.providerOwnsReasoningEffort = false;
}

export interface CodexAppServerRuntimeOptions {
  createClient?: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  materializationTimeoutMs?: number;
  settingsUpdateTimeoutMs?: number;
  capacityRetryDelaysMs?: readonly number[];
  capacityRetryDelay?: (delayMs: number) => Promise<void>;
  nativePathDiscoveryRefresh?: NativePathDiscoveryRefreshLimiterOptions;
  retainedSourceIdlePurge?: { intervalMs?: number; maxIdleMs?: number };
  logger?: AgentLogger;
  skillDiscovery?: CodexSkillDiscovery;
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
