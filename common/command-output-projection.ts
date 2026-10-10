import { CommandOutputMessage, type ChatMessage } from './chat-types.js';

// Markdown requires complete capture and delivery evidence in the loaded window.
export function projectCommandOutput(messages: readonly (ChatMessage | null)[]): Map<number, CommandOutputMessage> {
  const outputEvidence = new Map<string, { firstIndex: number; stdoutCount: number }>();
  const results = new Map<string, { index: number; complete: boolean; lastGapIndex: number }>();
  let lastGapIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message?.type === 'transcript-notice' && message.detail?.type === 'publication-gap') {
      lastGapIndex = index;
    }
    if (message?.type === 'command-result') {
      results.set(message.commandId, {
        index,
        complete: message.result.capture === 'complete' && !results.has(message.commandId),
        lastGapIndex,
      });
    }
    if (message?.type !== 'command-output') continue;
    const evidence = outputEvidence.get(message.commandId) ?? { firstIndex: index, stdoutCount: 0 };
    if (message.channel === 'stdout') evidence.stdoutCount += 1;
    outputEvidence.set(message.commandId, evidence);
  }

  const projections = new Map<number, CommandOutputMessage>();
  for (const [index, message] of messages.entries()) {
    if (message?.type !== 'command-output') continue;
    const evidence = outputEvidence.get(message.commandId)!;
    const result = results.get(message.commandId);
    const complete = message.channel === 'stdout' && message.offset === 0
      && evidence.stdoutCount === 1
      && result?.complete && result.index > index
      && result.lastGapIndex < evidence.firstIndex;
    projections.set(index, message.format === 'markdown' && !complete
      ? new CommandOutputMessage(message.timestamp, message.commandId, message.channel, 'plain',
        message.content, message.context, message.offset)
      : message);
  }
  return projections;
}
