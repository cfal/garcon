import crypto from 'node:crypto';
import type { CompactionTrigger } from '@garcon/common/chat-types';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { ClaudeTurnState } from './cli-protocol.js';

export class ClaudeActiveTurn {
  readonly protocol: ClaudeTurnState;
  readonly startedAt = Date.now();
  readonly completion: Promise<void>;
  readonly preStartAbortConfirmation: Promise<void>;
  abortTimer: ReturnType<typeof setTimeout> | null = null;
  // Pairs a compact boundary with the synthetic summary user message.
  pendingCompaction?: { trigger: CompactionTrigger; preTokens?: number; postTokens?: number };
  #resolve: (() => void) | null = null;
  #confirmPreStartAbort: (() => void) | null = null;

  constructor(
    readonly eventMetadata: RuntimeEventMetadata,
    backgroundTaskCount: number,
  ) {
    this.protocol = new ClaudeTurnState(crypto.randomUUID(), backgroundTaskCount);
    this.completion = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
    this.preStartAbortConfirmation = new Promise<void>((resolve) => {
      this.#confirmPreStartAbort = resolve;
    });
  }

  finish(): void {
    this.#resolve?.();
    this.#resolve = null;
  }

  confirmPreStartAbort(): void {
    this.#confirmPreStartAbort?.();
    this.#confirmPreStartAbort = null;
  }
}
