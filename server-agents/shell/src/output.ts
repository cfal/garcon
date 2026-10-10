import { CommandOutputMessage } from '@garcon/common/chat-types';

export const COMMAND_OUTPUT_BYTES = 64 * 1024;

export class CommandOutputTail {
  readonly #chunks: CommandOutputMessage[] = [];
  #bytes = 0;
  truncated = false;

  append(message: CommandOutputMessage): void {
    this.#chunks.push(message);
    this.#bytes += Buffer.byteLength(message.content);
    while (this.#bytes > COMMAND_OUTPUT_BYTES) {
      this.truncated = true;
      const first = this.#chunks[0]!;
      const bytes = Buffer.from(first.content);
      const excess = this.#bytes - COMMAND_OUTPUT_BYTES;
      if (bytes.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= bytes.length;
        continue;
      }
      let start = excess;
      // Retained UTF-8 starts at a code point, not a continuation byte.
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      const content = bytes.subarray(start).toString('utf8');
      this.#chunks[0] = new CommandOutputMessage(first.timestamp, first.commandId, first.channel,
        first.format, content, first.context, first.offset + first.content.length - content.length);
      this.#bytes -= start;
    }
  }

  messages(): CommandOutputMessage[] {
    const messages: CommandOutputMessage[] = [];
    for (const channel of ['stdout', 'stderr'] as const) {
      const chunks = this.#chunks.filter(message => message.channel === channel);
      const first = chunks[0];
      if (!first) continue;
      messages.push(new CommandOutputMessage(first.timestamp, first.commandId, channel, this.truncated ? 'plain' : first.format,
        chunks.map(message => message.content).join(''), first.context, first.offset));
    }
    return messages;
  }
}
