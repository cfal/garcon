import { tick } from 'svelte';
import { ActiveTranscriptState } from '../../../web/src/lib/chat/transcript/active-transcript-state.svelte.js';
import { ConversationFeedProjectionState } from '../../../web/src/lib/components/chat/transcript/ConversationFeedProjectionState.svelte.js';
import { AssistantMessage, ReadToolUseMessage, UserMessage } from '../../../common/chat-types.js';

export interface TranscriptProjectionMeasurement {
  combined: boolean;
  initialRows: number;
  finalRows: number;
  samples: number;
  medianMs: number;
  p95Ms: number;
  firstRowRetained: boolean;
  lastRowRetained: boolean;
}

async function measureProjection(combined: boolean): Promise<TranscriptProjectionMeasurement> {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const transcript = new ActiveTranscriptState();
  const projection = new ConversationFeedProjectionState();
  const initialRows = 5_000;
  const samples = 200;
  transcript.applyMessages('synthetic-chat', 'synthetic-view', [
    { ordinal: 1, message: new UserMessage(timestamp, 'Synthetic prompt') },
    { ordinal: 2, message: new AssistantMessage(timestamp, 'Synthetic response') },
    ...Array.from({ length: initialRows - 2 }, (_, index) => ({
      ordinal: index + 3,
      message: new ReadToolUseMessage(timestamp, `synthetic-tool-${index + 3}`, '/synthetic'),
    })),
  ], 1, initialRows);
  const options: Parameters<ConversationFeedProjectionState['reconcile']>[0] = {
    surfaceIdentity: 'synthetic-chat:synthetic-view',
    rows: transcript.displayRows, mutationClock: transcript.feedMutationClock,
    hiddenToolTypes: [], hiddenBashCommands: null, showThinking: true,
    combineToolUseMessages: combined, expandedToolMemberIds: new Set(), protectedVirtualKeys: [],
    isLiveWindow: true, showRefreshError: false, earlierBoundary: 'hidden',
    showLaterBoundary: false, reserveComposerTraySpace: false,
    transcriptViewId: 'synthetic-view', pendingPermissions: [],
  };
  let result = projection.reconcile(options);
  const durations: number[] = [];
  for (let ordinal = initialRows + 1; ordinal <= initialRows + samples; ordinal += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const start = performance.now();
    transcript.applyMessages('synthetic-chat', 'synthetic-view', [{
      ordinal, message: new ReadToolUseMessage(timestamp, `synthetic-tool-${ordinal}`, '/synthetic'),
    }], ordinal, ordinal);
    result = projection.reconcile({
      ...options, rows: transcript.displayRows, mutationClock: transcript.feedMutationClock,
    });
    await tick();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  transcript.transcriptCache.flush();
  return {
    combined, initialRows, finalRows: transcript.entries.length, samples,
    medianMs: durations[Math.floor(samples / 2)]!,
    p95Ms: durations[Math.floor(samples * 0.95)]!,
    firstRowRetained: result.model.indexByRowId.has('synthetic-view:1'),
    lastRowRetained: result.model.indexByRowId.has(`synthetic-view:${initialRows + samples}`),
  };
}

Object.assign(globalThis, { measureTranscriptProjection: measureProjection });
