import type { CommandOutputMessage } from '@garcon/common/chat-types';

// Capture stays chunked for bounded persistence and transport frames; presentation waits for settlement.
export class CommandOutputCapture {
  readonly #stdout: CommandOutputMessage[] = [];
  readonly #stderr: CommandOutputMessage[] = [];

  append(message: CommandOutputMessage): void {
    (message.channel === 'stdout' ? this.#stdout : this.#stderr).push(message);
  }

  *drain(): Iterable<CommandOutputMessage> {
    yield* this.#stdout;
    yield* this.#stderr;
    this.#stdout.length = 0;
    this.#stderr.length = 0;
  }
}
