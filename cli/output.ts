import type { ChatStopOutcome } from '@garcon/common/chat-types';

export interface CliWritable {
  write(chunk: string): unknown;
}

export type AsyncDelivery = 'new-turn' | 'steer';

export interface CliOutput {
  accepted(chatId: string): void;
  completed(messages: readonly string[]): void;
  listing(content: string): void;
  sent(chatId: string, delivery: AsyncDelivery, turnId: string): void;
  stopped(chatId: string, outcome: Exclude<ChatStopOutcome, 'failed'>): void;
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
      if (nonEmpty.length === 0) return;
      stdout.write(`${nonEmpty.join('\n\n')}\n`);
    },
    listing(content) {
      stdout.write(`${content.replace(/\n+$/, '')}\n`);
    },
    sent(chatId, delivery, turnId) {
      stdout.write(`chat id: ${chatId}\ndelivery: ${delivery}\nturn id: ${turnId}\n`);
    },
    stopped(chatId, outcome) {
      stdout.write(`chat id: ${chatId}\nstop: ${outcome}\n`);
    },
    diagnostic(message) {
      stderr.write(`${message}\n`);
    },
  };
}