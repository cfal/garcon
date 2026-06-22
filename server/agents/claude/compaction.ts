// Shared helpers for interpreting the `claude` CLI's context-compaction output.
// The CLI emits a `compact_boundary` carrying token metadata followed by a
// synthetic user message that opens with COMPACT_SUMMARY_PREAMBLE and contains
// the generated summary. Both the live transport and the history loader fold
// these into a single CompactionMessage.

import type { CompactionTrigger } from '../../../common/chat-types.js';

// Opening text of the synthetic user message that carries a post-compaction summary.
export const COMPACT_SUMMARY_PREAMBLE = 'This session is being continued from a previous conversation';

export interface CompactionInfo {
  trigger: CompactionTrigger;
  preTokens?: number;
  postTokens?: number;
}

// Reads trigger and pre/post token counts from a `compact_boundary` metadata
// object. The live stream uses snake_case keys (`pre_tokens`) while the on-disk
// session history uses camelCase (`preTokens`), so both are accepted.
export function parseCompactMetadata(metadata: unknown): CompactionInfo {
  const meta = (metadata && typeof metadata === 'object') ? metadata as Record<string, unknown> : {};
  const num = (...values: unknown[]): number | undefined =>
    values.find((value): value is number => typeof value === 'number');
  return {
    trigger: meta.trigger === 'auto' ? 'auto' : 'manual',
    preTokens: num(meta.pre_tokens, meta.preTokens),
    postTokens: num(meta.post_tokens, meta.postTokens),
  };
}

// Strips the continuation boilerplate from a summary, keeping the body the agent
// generated. Falls back to the trimmed input when the `Summary:` marker is absent.
export function extractCompactionSummary(text: string): string {
  const marker = text.indexOf('Summary:');
  const body = marker >= 0 ? text.slice(marker + 'Summary:'.length) : text;
  return body.trim();
}

// Whether a user message's text content is a post-compaction summary payload.
export function isCompactionSummaryText(text: string): boolean {
  return text.startsWith(COMPACT_SUMMARY_PREAMBLE);
}
