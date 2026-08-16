import crypto from 'node:crypto';
import type { CompactionTrigger } from '@garcon/common/chat-types';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import { ClaudeTurnState } from './cli-protocol.js';
import { ClaudeTurnSteeringState } from './steering.js';

export class ClaudeActiveTurn {
  readonly protocol: ClaudeTurnState;
  readonly steering = new ClaudeTurnSteeringState();
  readonly startedAt = Date.now();
  readonly completion: Promise<void>;
  readonly preStartAbortConfirmation: Promise<void>;
  abortTimer: ReturnType<typeof setTimeout> | null = null;
  // Pairs a compact boundary with the synthetic summary user message.
  pendingCompaction?: { trigger: CompactionTrigger; preTokens?: number; postTokens?: number };
  #resolve: (() => void) | null = null;
  #confirmPreStartAbort: (() => void) | null = null;
  #interruptRequestFailed = false;

  constructor(
    readonly turnId: string,
    backgroundTaskCount: number,
    readonly operation: AgentRuntimeOperation,
  ) {
    this.protocol = new ClaudeTurnState(
      crypto.randomUUID(),
      backgroundTaskCount,
    );
    this.completion = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
    this.preStartAbortConfirmation = new Promise<void>((resolve) => {
      this.#confirmPreStartAbort = resolve;
    });
  }

  finish(): void {
    this.steering.clear();
    this.#resolve?.();
    this.#resolve = null;
  }

  confirmPreStartAbort(): void {
    this.#confirmPreStartAbort?.();
    this.#confirmPreStartAbort = null;
  }

  markInterruptRequestFailed(): void {
    if (this.protocol.abortRequested) this.#interruptRequestFailed = true;
  }

  get interruptRequestFailed(): boolean {
    return this.#interruptRequestFailed;
  }
}
