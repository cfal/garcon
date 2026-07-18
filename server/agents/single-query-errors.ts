import type { ThinkingMode } from '../../common/chat-modes.js';

export class UnsupportedSingleQueryEffortError extends Error {
  constructor(
    readonly agentId: string,
    readonly effort: Exclude<ThinkingMode, 'none'>,
  ) {
    super(`${agentId} does not support explicit one-shot effort ${effort}.`);
    this.name = 'UnsupportedSingleQueryEffortError';
  }
}
