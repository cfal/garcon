import { describe, expect, test } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type { WaitCliCommand } from '../args.js';
import { runChatWait } from '../chat-wait.js';
import { CliError } from '../errors.js';
import { GarconHttpError } from '../garcon-client.js';
import type { CliOutput } from '../output.js';
import type { ReceiptClient } from '../receipt-poller.js';

const CHAT_ID = '1785337200123456';
const TIMESTAMP = '2026-08-04T12:00:00.000Z';
const command: WaitCliCommand = {
  kind: 'wait',
  workspace: 'work',
  configDir: '/config',
  chatId: CHAT_ID,
  turnId: 'turn-1',
  json: false,
};
const completed: AgentTurnReceipt = {
  state: 'completed',
  chatId: CHAT_ID,
  turnId: 'turn-1',
  clientRequestId: 'request-1',
  acceptedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  settledAt: TIMESTAMP,
  output: {
    availability: 'available',
    completeness: 'complete',
    assistantMessages: ['Done'],
  },
};

function output(): CliOutput & {
  handles: Array<{ chatId: string; turnId: string }>;
  messages: string[][];
  results: string[];
} {
  return {
    handles: [],
    messages: [],
    results: [],
    accepted({ chatId, turnId }) { this.handles.push({ chatId, turnId }); },
    completed(messages) { this.messages.push([...messages]); },
    result(content) { this.results.push(content); },
    sent() {},
    stopped() {},
    diagnostic() {},
  };
}

describe('runChatWait', () => {
  test('renders an already completed exact turn without submitting work', async () => {
    let reads = 0;
    const client: ReceiptClient = {
      async getTurnReceipt(chatId, turnId) {
        reads += 1;
        expect([chatId, turnId]).toEqual([CHAT_ID, 'turn-1']);
        return completed;
      },
      async verifyRuntime() { return true; },
    };
    const capture = output();

    await runChatWait(command, client, capture);

    expect(reads).toBe(1);
    expect(capture.handles).toEqual([{ chatId: CHAT_ID, turnId: 'turn-1' }]);
    expect(capture.messages).toEqual([['Done']]);
  });

  test('emits one terminal receipt document in JSON mode', async () => {
    const capture = output();
    await runChatWait({ ...command, json: true }, {
      async getTurnReceipt() { return completed; },
      async verifyRuntime() { return true; },
    }, capture);

    expect(capture.results).toEqual([JSON.stringify(completed, null, 2)]);
    expect(capture.handles).toEqual([]);
    expect(capture.messages).toEqual([]);
  });

  test('preserves failed receipt exit semantics after JSON output', async () => {
    const failed: AgentTurnReceipt = {
      ...completed,
      state: 'failed',
      error: 'provider failed',
      errorCode: 'INTERNAL_ERROR',
      output: {
        availability: 'available',
        completeness: 'best-effort',
        assistantMessages: ['Partial'],
      },
    };
    const capture = output();

    try {
      await runChatWait({ ...command, json: true }, {
        async getTurnReceipt() { return failed; },
        async verifyRuntime() { return true; },
      }, capture);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
    }
    expect(capture.results).toEqual([JSON.stringify(failed, null, 2)]);
  });

  test('names the effective workspace when an exact receipt is missing', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() {
        throw new GarconHttpError(
          'receipt polling',
          'Turn receipt not found',
          404,
          'TURN_RECEIPT_NOT_FOUND',
          false,
        );
      },
      async verifyRuntime() { return true; },
    };

    await expect(runChatWait(command, client, output()))
      .rejects.toThrow('Garcon workspace "work"');
  });
});
