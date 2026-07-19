import type { ThinkingMode } from '@garcon/common/chat-modes';

export class UnsupportedSingleQueryEffortError extends Error {
  constructor(
    readonly agentId: string,
    readonly effort: Exclude<ThinkingMode, 'none'>,
  ) {
    super(`${agentId} does not support explicit one-shot effort ${effort}.`);
    this.name = 'UnsupportedSingleQueryEffortError';
  }
}
