import type { TranscriptRendering } from '../client.ts';
import { runTranscriptRenderingTask } from '../tasks.ts';

// Runs rendering tasks in-process on structured clones, matching what the Worker receives.
export const inlineTranscriptRendering = {
  async renderTranscriptExport({ rows, ...request }, signal) {
    signal?.throwIfAborted();
    return runTranscriptRenderingTask({ kind: 'render-transcript-export', ...request }, structuredClone(rows));
  },
} satisfies TranscriptRendering;
