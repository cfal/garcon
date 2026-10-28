import type { TranscriptRendering } from '../client.ts';
import { runTranscriptRenderingTask } from '../tasks.ts';

// Runs rendering tasks in-process on structured clones, matching what the Worker receives.
export const inlineTranscriptRendering = {
  async renderTranscriptExport({ rows, ...request }, signal) {
    signal?.throwIfAborted();
    return runTranscriptRenderingTask({ kind: 'render-transcript-export', ...request }, structuredClone(rows));
  },
  async renderShareSnapshot({ header, rows }, signal) {
    signal?.throwIfAborted();
    return runTranscriptRenderingTask({ kind: 'render-share-snapshot', header }, structuredClone(rows));
  },
  async upgradeShareSnapshot(shareToken, format, snapshotPath, signal) {
    signal?.throwIfAborted();
    return runTranscriptRenderingTask({ kind: 'upgrade-share-snapshot', shareToken, format, snapshotPath }, []);
  },
} satisfies TranscriptRendering;
