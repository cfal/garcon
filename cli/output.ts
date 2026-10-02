import type { ChatStopOutcome } from '@garcon/common/chat-types';
import type { AgentTurnCommandResponse } from '@garcon/common/chat-command-contracts';
import { terminalBody, terminalLine } from './terminal-output.js';

export interface CliWritable {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export type AsyncDelivery = 'new-turn' | 'steer';

export interface CliOutput {
  accepted(handle: Pick<AgentTurnCommandResponse, 'chatId' | 'turnId'>): void;
  completed(text: string): void;
  document(content: string): void;
  result(content: string): void;
  sent(chatId: string, delivery: AsyncDelivery, turnId: string): void;
  stopped(chatId: string, outcome: Exclude<ChatStopOutcome, 'failed'>): void;
  diagnostic(message: string): void;
}

export function createCliOutput(
  stdout: CliWritable = process.stdout,
  stderr: CliWritable = process.stderr,
): CliOutput {
  return {
    accepted({ chatId, turnId }) {
      stdout.write(`chat id: ${terminalLine(chatId)}\nturn id: ${terminalLine(turnId)}\n`);
    },
    completed(text) {
      if (text.length > 0) stdout.write(`${stdout.isTTY ? terminalBody(text) : text}\n`);
    },
    document(content) {
      stdout.write(content);
    },
    result(content) {
      stdout.write(`${content.replace(/\n+$/, '')}\n`);
    },
    sent(chatId, delivery, turnId) {
      stdout.write(`chat id: ${terminalLine(chatId)}\ndelivery: ${delivery}\nturn id: ${terminalLine(turnId)}\n`);
    },
    stopped(chatId, outcome) {
      stdout.write(`chat id: ${terminalLine(chatId)}\nstop: ${outcome}\n`);
    },
    diagnostic(message) {
      stderr.write(`${terminalBody(message)}\n`);
    },
  };
}
