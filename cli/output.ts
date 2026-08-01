export interface CliWritable {
  write(chunk: string): unknown;
}

export interface CliOutput {
  accepted(chatId: string): void;
  completed(messages: readonly string[]): void;
  diagnostic(message: string): void;
}

export function createCliOutput(
  stdout: CliWritable = process.stdout,
  stderr: CliWritable = process.stderr,
): CliOutput {
  return {
    accepted(chatId) {
      stdout.write(`chat id: ${chatId}\n`);
    },
    completed(messages) {
      const nonEmpty = messages.filter((message) => message.trim().length > 0);
      stdout.write(`${nonEmpty.join('\n\n')}\n`);
    },
    diagnostic(message) {
      stderr.write(`${message}\n`);
    },
  };
}
