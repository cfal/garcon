import type { PiRpcClient } from './pi-rpc-client.js';
import type { piEventMetadata } from './runtime-types.js';

export type PiRpcSessionState = 'starting' | 'idle' | 'prompting' | 'active' | 'retiring';

export interface PiSteerSubmission {
  readonly input: string;
  accepted: boolean;
  delivered: boolean;
  persisted: boolean;
}

export interface PiActiveTurn {
  turnId: string | undefined;
  stopRequested: boolean;
  settleObserved: boolean;
  completion: 'pending' | 'finished' | 'failed' | 'stopped' | 'shutdown';
  failureMessage: string | null;
  readonly steerSubmissions: Set<PiSteerSubmission>;
  steeringQueue: readonly string[];
  settle(): void;
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
