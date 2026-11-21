import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '../execution/runtime-events.js';
import type { AcpClient } from './client.js';
import type { AcpJsonRpcId, AcpSessionConfigOption, AcpSessionModelState } from './protocol.js';
import type { AcpAdvertisedCapabilities } from './reconnect-policy.js';

export type RuntimeSessionState = 'idle' | 'running' | 'failed' | 'aborted';

export interface PendingPermissionRequest {
  readonly permissionOccurrenceId: string;
  readonly session: AcpAgentRuntimeSession;
  readonly turn: AcpTurnContext;
  readonly requestId: AcpJsonRpcId;
  readonly responseForDecision: (decision: PermissionDecisionPayload) => Record<string, unknown>;
  readonly responseForCancellation: (
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ) => Record<string, unknown>;
}

export interface AcpAgentRuntimeSession {
  id: string;
  remoteSessionId: string;
  chatId: string;
  projectPath: string;
  client: AcpClient;
  capabilities: AcpAdvertisedCapabilities;
  state: RuntimeSessionState;
  retired: boolean;
  // Set when the owning chat let go of the session, which no queued turn may undo.
  released?: boolean;
  activeTurn: AcpTurnContext | null;
  sourceTurn: AcpTurnContext | null;
  // The turn between admission and its prompt being sent. Its configure
  // window counts as busy for concurrent turns, the idle purger, and path
  // updates, and Stop during it aborts the turn before the prompt goes out.
  pendingTurn: AcpTurnContext | null;
  permissionMode: PermissionMode;
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
  // The model the agent selected when this process opened the session; an empty
  // request returns to it. After a reconnect it is the model the session resumed with.
  agentDefaultModelId?: string;
  startedAt: string;
  lastActivityAt: number;
}

export interface AcpTurnContext {
  readonly session: AcpAgentRuntimeSession;
  readonly operation: AgentRuntimeOperation;
  readonly pendingPermissions: Set<PendingPermissionRequest>;
  readonly detachSourceListeners: Array<() => void>;
  permissionMode: PermissionMode;
  running: boolean;
  completed: boolean;
  aborted: boolean;
  sourceActive: boolean;
  sourceRetired: boolean;
  readonly settled: PromiseWithResolvers<void>;
  cancelTimer: ReturnType<typeof setTimeout> | null;
}

type AcpRuntimeSessionIdentity = Pick<AcpAgentRuntimeSession,
  'id' | 'remoteSessionId' | 'chatId' | 'projectPath' | 'client' | 'capabilities' | 'permissionMode'
  | 'configOptions' | 'models' | 'agentDefaultModelId'>;

// An idle, unregistered session for a process that just opened or resumed it.
export function newRuntimeSession(identity: AcpRuntimeSessionIdentity, startedAt = new Date().toISOString()): AcpAgentRuntimeSession {
  return {
    ...identity,
    state: 'idle',
    retired: false,
    activeTurn: null,
    sourceTurn: null,
    pendingTurn: null,
    startedAt,
    lastActivityAt: Date.now(),
  };
}
