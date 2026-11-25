import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '../execution/runtime-events.js';
import type { AcpClient } from './client.js';
import type {
  AcpJsonRpcId,
  AcpSessionConfigOption,
  AcpSessionModelState,
  AcpSessionPromptResult,
} from './protocol.js';

export type RuntimeSessionState = 'idle' | 'running' | 'failed' | 'aborted';

export interface PendingPermissionRequest {
  readonly permissionOccurrenceId: string;
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
  readonly settled: PromiseWithResolvers<void>;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  // Prompts of this turn the agent has not settled. Each steer adds one.
  readonly openPrompts: Set<Promise<AcpSessionPromptResult>>;
  // Steers between their target check and the agent's decision. They hold the
  // turn open, so a steer recorded in the transcript still reaches the agent.
  steersInFlight: number;
  // Held by one steer at a time, from its checks to the agent's decision.
  steerSlot: Promise<void> | null;
  // The failure of the turn's last settled prompt, unless that was a refused steer.
  promptFailure: { readonly error: unknown } | null;
  // Resolved, and `promptsClosed` set, once no prompt is open and no steer is in flight.
  readonly promptsDrained: PromiseWithResolvers<void>;
  promptsClosed: boolean;
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
