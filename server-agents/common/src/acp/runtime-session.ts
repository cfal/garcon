import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '../execution/runtime-events.js';
import type { AcpClient } from './client.js';
import type { AcpJsonRpcId, AcpSessionConfigOption, AcpSessionModelState } from './protocol.js';
import type { AcpTurnPrompts } from './turn-prompts.js';

export type RuntimeSessionState = 'idle' | 'running' | 'failed' | 'aborted';

export interface PendingPermissionRequest {
  readonly permissionOccurrenceId: string;
  readonly toolCallId: string;
  readonly turn: AcpTurnContext;
  readonly requestId: AcpJsonRpcId;
  readonly responseForDecision: (decision: PermissionDecisionPayload) => Record<string, unknown>;
  readonly responseForCancellation: (
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ) => Record<string, unknown>;
}

export interface AcpAgentRuntimeSession {
  id: string;
  chatId: string;
  projectPath: string;
  client: AcpClient;
  state: RuntimeSessionState;
  retired: boolean;
  activeTurn: AcpTurnContext | null;
  sourceTurn: AcpTurnContext | null;
  // The turn between admission and its prompt being sent. Its configure
  // window counts as busy for concurrent turns, the idle purger, and path
  // updates, and Stop during it aborts the turn before the prompt goes out.
  pendingTurn: AcpTurnContext | null;
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
  startedAt: string;
  lastActivityAt: number;
}

export interface AcpTurnContext {
  readonly session: AcpAgentRuntimeSession;
  readonly operation: AgentRuntimeOperation;
  readonly pendingPermissions: Set<PendingPermissionRequest>;
  readonly detachSourceListeners: Array<() => void>;
  permissionMode: PermissionMode;
  completed: boolean;
  aborted: boolean;
  sourceRetired: boolean;
  finalResponseText: string | null;
  reportedFailure: boolean;
  readonly settled: PromiseWithResolvers<void>;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  readonly prompts: AcpTurnPrompts;
}

type AcpRuntimeSessionIdentity = Pick<AcpAgentRuntimeSession,
  'id' | 'chatId' | 'projectPath' | 'client'
  | 'configOptions' | 'models'>;

// An idle, unregistered session for a process that just opened or resumed it.
export function newRuntimeSession(identity: AcpRuntimeSessionIdentity): AcpAgentRuntimeSession {
  return {
    ...identity,
    state: 'idle',
    retired: false,
    activeTurn: null,
    sourceTurn: null,
    pendingTurn: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: Date.now(),
  };
}
