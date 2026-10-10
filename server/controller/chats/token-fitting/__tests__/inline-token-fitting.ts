import type { TokenFitting } from '../client.ts';
import { runTokenFittingTask } from '../tasks.ts';

// Runs fitting tasks in-process on structured clones, matching what the Worker receives.
export const inlineTokenFitting = {
  async projectCompactedCarryover(messages, summary, signal) {
    signal?.throwIfAborted();
    return runTokenFittingTask({ kind: 'project-compacted-carryover', summary }, structuredClone(messages));
  },
  async assessCarryover(messages, signal) {
    signal?.throwIfAborted();
    return runTokenFittingTask({ kind: 'assess-carryover' }, structuredClone(messages));
  },
  async fitCompactionPrompt({ messages, ...parameters }, signal) {
    signal?.throwIfAborted();
    return runTokenFittingTask(
      { kind: 'fit-compaction-prompt', ...parameters },
      structuredClone(messages),
    );
  },
  async renderHandoffArtifact({ rows, ...parameters }, signal) {
    signal?.throwIfAborted();
    return runTokenFittingTask(
      { kind: 'render-handoff-artifact', ...parameters },
      structuredClone(rows),
    );
  },
} satisfies TokenFitting;
