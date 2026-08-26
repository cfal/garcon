import { AssistantMessage, UserMessage } from '../common/chat-types.js';
import {
  estimateHandoffTokens,
} from '../server/chats/handoff-token-budget.js';
import {
  foldHandoffArtifactEntries,
  renderHandoffArtifactEntry,
} from '../server/chats/handoff-artifact/projection.js';
import { renderFittedHandoffArtifact } from '../server/chats/handoff-artifact/xml.js';

const AT = '2026-08-26T00:00:00.000Z';
const TARGETS = [100_000, 500_000, 1_000_000] as const;
const MAX_FIT_RENDER_PASSES = 9;
const BODY = [
  'Synthetic implementation history with generic identifiers.',
  'Files: src/module.ts, tests/module.test.ts.',
  'Decision: preserve the provider-neutral boundary and verify every contract.',
].join(' ').repeat(24);

for (const targetTokens of TARGETS) {
  const startedAt = performance.now();
  const rssSamples = [process.memoryUsage.rss()];
  const messages = syntheticMessages(targetTokens);
  const projectionStartedAt = performance.now();
  const sourceFold = foldHandoffArtifactEntries(messages.map((message, index) => ({
    kind: 'message',
    ordinal: index + 1,
    category: 'conversation',
    message,
  })));
  const projectionMs = performance.now() - projectionStartedAt;
  rssSamples.push(process.memoryUsage.rss());

  const renderStartedAt = performance.now();
  const rendered = renderFittedHandoffArtifact({
    chat: {
      id: '1787505989127000',
      title: 'Synthetic benchmark',
      agentId: 'benchmark-agent',
      model: 'benchmark-model',
    },
    transcriptViewId: 'benchmark-view',
    lastOrdinal: sourceFold.eligibleEntryCount,
    contextWindowTokens: targetTokens,
    sourceFold,
  });
  const renderMs = performance.now() - renderStartedAt;
  rssSamples.push(process.memoryUsage.rss());
  if (!rendered) throw new Error(`Artifact did not fit for ${targetTokens} tokens`);
  if (rendered.fitCorrectionPasses > MAX_FIT_RENDER_PASSES) {
    throw new Error('Correction pass limit exceeded');
  }

  const sourceEstimatedTokens = sourceFold.entries.reduce(
    (total, entry) => total + estimateHandoffTokens(renderHandoffArtifactEntry(entry)),
    0,
  );
  console.log(JSON.stringify({
    targetTokens,
    sourceEstimatedTokens,
    entryVisits: sourceFold.sourceEntryCount,
    includedEntries: rendered.includedEntryCount,
    budgetOmittedEntries: rendered.budgetOmittedEntryCount,
    estimatedArtifactTokens: rendered.estimatedTokens,
    fitCorrectionPasses: rendered.fitCorrectionPasses,
    metadataPasses: rendered.metadataPasses,
    projectionMs: rounded(projectionMs),
    renderMs: rounded(renderMs),
    totalMs: rounded(performance.now() - startedAt),
    peakSampledRssBytes: Math.max(...rssSamples),
  }));
}

function syntheticMessages(targetTokens: number) {
  const tokensPerTurn = Math.max(1, estimateHandoffTokens(BODY) * 2);
  const turnCount = Math.max(1, Math.ceil(targetTokens / tokensPerTurn));
  return Array.from({ length: turnCount }, (_, index) => [
    new UserMessage(AT, `Objective ${index}: ${BODY}`),
    new AssistantMessage(AT, `Result ${index}: ${BODY}`),
  ]).flat();
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
