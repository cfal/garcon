import { CommandOutputMessage, type ChatMessage } from './chat-types.js';

// Markdown requires complete capture and delivery evidence in the loaded window.
export function projectCommandOutput(messages: readonly (ChatMessage | null)[]): Map<number, CommandOutputMessage> {
  const firstOutput = new Map<string, number>();
  const streamCounts = new Map<string, number>();
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
    if (!firstOutput.has(message.commandId)) firstOutput.set(message.commandId, index);
    const key = JSON.stringify([message.commandId, message.channel]);
    streamCounts.set(key, (streamCounts.get(key) ?? 0) + 1);
  }

  const projections = new Map<number, CommandOutputMessage>();
  for (const [index, message] of messages.entries()) {
    if (message?.type !== 'command-output') continue;
    const result = results.get(message.commandId);
    const complete = message.channel === 'stdout' && message.offset === 0
      && streamCounts.get(JSON.stringify([message.commandId, message.channel])) === 1
      && result?.complete && result.index > index
      && result.lastGapIndex < firstOutput.get(message.commandId)!;
    projections.set(index, message.format === 'markdown' && !complete
      ? new CommandOutputMessage(message.timestamp, message.commandId, message.channel, 'plain',
        message.content, message.context, message.offset)
      : message);
  }
  return projections;
}
