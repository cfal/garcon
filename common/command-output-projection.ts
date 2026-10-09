import { CommandOutputMessage, type ChatMessage } from './chat-types.js';

interface OutputChunk {
  index: number;
  message: CommandOutputMessage;
}

export interface CommandOutputProjection {
  message: CommandOutputMessage;
  parentIndex: number;
}

// Storage chunks remain addressable; incomplete Markdown windows render literally.
export function projectCommandOutput(messages: readonly (ChatMessage | null)[]): Map<number, CommandOutputProjection> {
  const documents = new Map<string, OutputChunk[]>();
  const completed = new Set<string>();
  const open = new Set<string>();
  const interrupted = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message?.type === 'transcript-notice' && message.detail?.type === 'publication-gap') {
      for (const commandId of open) interrupted.add(commandId);
    }
    if (message?.type === 'command-result') {
      open.delete(message.commandId);
      if (message.result.capture === 'complete' && !interrupted.has(message.commandId)) completed.add(message.commandId);
    }
    if (message?.type !== 'command-output') continue;
    open.add(message.commandId);
    const key = JSON.stringify([message.commandId, message.channel]);
    const chunks = documents.get(key) ?? [];
    chunks.push({ index, message });
    documents.set(key, chunks);
  }
  const projections = new Map<number, CommandOutputProjection>();
  for (const chunks of documents.values()) {
    const first = chunks[0];
    let length = 0;
    let contiguous = true;
    for (const { message } of chunks) {
      if (message.offset !== first.message.offset + length || message.format !== first.message.format
        || message.context.executorId !== first.message.context.executorId
        || message.context.projectPath !== first.message.context.projectPath) contiguous = false;
      length += message.content.length;
    }
    if (!contiguous) {
      for (const { index, message } of chunks) {
        projections.set(index, { parentIndex: index, message: new CommandOutputMessage(
          message.timestamp, message.commandId, message.channel, 'plain', message.content, message.context, message.offset,
        ) });
      }
      continue;
    }
    const message = first.message;
    const format = message.offset === 0 && completed.has(message.commandId) ? message.format : 'plain';
    const document = new CommandOutputMessage(message.timestamp, message.commandId, message.channel, format,
      chunks.map(chunk => chunk.message.content).join(''), message.context, message.offset);
    for (const chunk of chunks) {
      projections.set(chunk.index, { parentIndex: first.index, message: chunk === first ? document : chunk.message });
    }
  }
  return projections;
}
