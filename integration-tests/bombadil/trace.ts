import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface TraceSummary {
  states: number;
  actions: number;
  violations: number;
  maxCaptureGapMs: number;
  observations: Record<string, unknown>[];
}

export async function readTrace(path: string): Promise<TraceSummary> {
  const summary: TraceSummary = { states: 0, actions: 0, violations: 0, maxCaptureGapMs: 0, observations: [] };
  let previous = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line);
      if (!Number.isFinite(entry.timestamp) || !Array.isArray(entry.snapshots)
        || !Array.isArray(entry.violations) || typeof entry.state?.url !== 'string' || !('action' in entry)) {
        throw new Error('Invalid Bombadil 0.7.10 trace entry');
      }
      summary.states++;
      if (entry.action !== null) summary.actions++;
      summary.violations += entry.violations.length;
      if (previous) summary.maxCaptureGapMs = Math.max(summary.maxCaptureGapMs, (entry.timestamp - previous) / 1_000);
      previous = entry.timestamp;
      for (const snapshot of entry.snapshots) {
        if (snapshot.value?.kind === 'garcon-bombadil-v1') {
          summary.observations.push(snapshot.value);
          if (summary.observations.length > 10_000) throw new Error('Bombadil observation budget exceeded');
        }
      }
    }
  } finally { lines.close(); }
  if (!summary.states) throw new Error('Empty Bombadil trace');
  return summary;
}

export function requireCoverage(summary: TraceSummary): void {
  if (summary.violations) throw new Error(`Bombadil recorded ${summary.violations} violations`);
  if (summary.states < 3 || summary.actions < 2
    || summary.observations.at(-1)?.complete !== true) {
    throw new Error('Bombadil did not complete the required workflow');
  }
}
