import type {
  AgentProjectionState,
  AgentTranscriptEntry,
  AgentTranscriptPageResultV4,
} from '@garcon/server-agent-interface';
import { sameProjectionState } from './identity.js';
import { createProjectionState } from './state.js';

export interface StagedProjectionReset {
  readonly projection: AgentProjectionState;
  readonly entries: readonly AgentTranscriptEntry[];
}

export async function stageProjectionReset(options: {
  readonly target: AgentProjectionState;
  readonly pageSize: number;
  readonly loadPage: (
    beforeOrdinal: number | null,
    expected: AgentProjectionState,
  ) => Promise<AgentTranscriptPageResultV4>;
}): Promise<StagedProjectionReset> {
  const reversedPages: (readonly AgentTranscriptEntry[])[] = [];
  let beforeOrdinal: number | null = null;
  let expectedFirstOrdinal = options.target.total + 1;
  while (expectedFirstOrdinal > 1) {
    const result = await options.loadPage(beforeOrdinal, options.target);
    if (result.kind !== 'ready') {
      throw new Error(`Projection reset target is ${result.kind}`);
    }
    if (!sameProjectionState(result.page.projection, options.target)) {
      throw new TypeError('Projection reset page changed its target state');
    }
    const pageEnd = result.page.firstOrdinal + result.page.entries.length;
    if (pageEnd !== expectedFirstOrdinal || result.page.entries.length === 0) {
      throw new TypeError('Projection reset pages are not contiguous');
    }
    reversedPages.push(result.page.entries);
    expectedFirstOrdinal = result.page.firstOrdinal;
    beforeOrdinal = result.page.firstOrdinal;
    if (!result.page.hasMore) break;
  }
  if (expectedFirstOrdinal !== 1) throw new TypeError('Projection reset target is incomplete');
  const entries = reversedPages.reverse().flat();
  const computed = createProjectionState(
    options.target.epoch,
    options.target.contentEpoch,
    entries,
  );
  if (!sameProjectionState(computed, options.target)) {
    throw new TypeError('Projection reset target revision validation failed');
  }
  return { projection: options.target, entries };
}
