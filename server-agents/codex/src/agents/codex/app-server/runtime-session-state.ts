import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { CodexExecutionRequest, CodexThreadConfiguration } from '../runtime-types.js';
import { codexServiceTier, type CodexServiceTier } from '../service-tier.js';
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
  mapThinkingModeToCodexEffort,
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

type CodexInferenceRoute = { readonly model: string; readonly serviceTier: CodexServiceTier };

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
  modelEndpointId: string | null;
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
  admittedRoute: CodexInferenceRoute;
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
  // Prevents idle reclamation during configuration work, without delaying explicit source retirement.
  configurationReservations: number;
  configurationFenced: boolean;
  // Wall-clock stamp taken when the session finishes while its source stays
  // retained; drives the idle reclamation sweep for retained writers.
  idleSince: number | null;
}

function providerOwnsReasoningEffort(request: CodexThreadConfiguration): boolean {
  return mapThinkingModeToCodexEffort(request.thinkingMode, request.model) === undefined;
}

export function recordExplicitReasoningEffort(
  session: RunningCodexSession,
  request: CodexThreadConfiguration,
): void {
  if (!providerOwnsReasoningEffort(request)) session.providerOwnsReasoningEffort = false;
}

export function canReuseThreadSettings(
  session: RunningCodexSession, request: CodexExecutionRequest,
): boolean {
  if (session.configurationFenced || session.pendingThreadSettings) return false;
  // Only fresh activation proves a premium tier; compaction cannot override a loaded tier.
  if (codexServiceTier(request.speed) !== 'default' || session.admittedRoute.serviceTier !== 'default') return false;
  if (session.confirmedThreadSettings.serviceTier !== 'default') return false;
  if (providerOwnsReasoningEffort(request) && !session.providerOwnsReasoningEffort) return false;
  return true;
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
  // Steering names the active turn, so an adopted turn can take it from now on.
  operation.publish({ type: 'steerable' });
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
