import type { PiRpcClient } from './pi-rpc-client.js';
import type { piEventMetadata } from './runtime-types.js';

export type PiRpcSessionState = 'starting' | 'idle' | 'prompting' | 'active' | 'retiring';

export interface PiSteerSubmission {
  readonly input: string;
  accepted: boolean;
  delivered: boolean;
  persisted: boolean;
}

// Message-entry identities present before the prompt. Unavailable when the
// file could not be read or held id-less entries, which makes occurrence
// accounting impossible and keeps the turn unresolved.
export type PiSettlementBaseline =
  | { readonly kind: 'ready'; readonly entryIds: ReadonlySet<string> }
  | { readonly kind: 'unavailable' };

export interface PiActiveTurn {
  turnId: string | undefined;
  stopRequested: boolean;
  settleObserved: boolean;
  completion: 'pending' | 'finished' | 'failed' | 'stopped' | 'shutdown';
  failureMessage: string | null;
  readonly steerSubmissions: Set<PiSteerSubmission>;
  steeringQueue: readonly string[];
  // Entry identities captured before the prompt was sent and the per-role
  // count of finalized message occurrences the turn must persist; settlement
  // verifies enough new entries appeared beyond the baseline.
  settlementBaseline: PiSettlementBaseline;
  readonly expectedNative: Map<string, number>;
  settle(): void;
}

// Settlement evidence captured when a turn finishes on agent_settled; the
// verdict is computed lazily against the current native file.
export interface PiTurnSettlementRecord {
  readonly steeringUnresolved: boolean;
  readonly baseline: PiSettlementBaseline;
  readonly expected: ReadonlyMap<string, number>;
  readonly nativePath: string | null;
}

export interface PiRpcSession {
  generation: number;
  state: PiRpcSessionState;
  id: string;
  chatId: string;
  nativePath: string | null;
  model: string;
  thinking: string | undefined;
  process: ReturnType<typeof Bun.spawn> | null;
  client: PiRpcClient | null;
  turn: PiActiveTurn | null;
  deliveryReservations: number;
  pendingFinish: (() => void) | null;
  startTime: number;
  lastActivityAt: number;
  eventMetadata: ReturnType<typeof piEventMetadata>;
  exitPromise: Promise<void> | null;
}

export interface CapturedPiSteerTarget {
  session: PiRpcSession;
  generation: number;
  turn: PiActiveTurn;
}

export interface PiRetireOptions {
  readonly turnOutcome?: 'failed' | 'stopped' | 'shutdown' | 'preserve';
  readonly failureMessage?: string;
}

export interface PiPromptDispatch {
  readonly accepted: Promise<void>;
  readonly settle: Promise<void>;
}
