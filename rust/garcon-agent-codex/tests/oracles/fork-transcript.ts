import { createCodexForkTranscriptRewriter } from '../../../../server-agents/codex/src/agents/codex/fork-transcript.ts';

export function rewriteCodexForkTranscriptSequence(
  entries: Parameters<ReturnType<typeof createCodexForkTranscriptRewriter>>[],
) {
  const rewrite = createCodexForkTranscriptRewriter();
  return entries.map(([entry, context]) => rewrite(entry, context));
}

export function forkEntryContext(context: Parameters<ReturnType<typeof createCodexForkTranscriptRewriter>>[1]) {
  const count = context?.retainedMessageCount;
  return typeof context?.sourceAgentSessionId === 'string'
    && typeof context?.targetAgentSessionId === 'string'
    && (count === undefined || (Number.isSafeInteger(count) && count >= 0));
}
