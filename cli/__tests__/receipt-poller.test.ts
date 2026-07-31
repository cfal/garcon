import { describe, expect, test } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { CliError } from '../errors.js';
import { GarconHttpError, GarconTransportError } from '../garcon-client.js';
import { pollTurnReceipt, type ReceiptClient } from '../receipt-poller.js';

const CHAT_ID = '1785337200123456';
const TURN_ID = 'turn-1';
const completed: AgentTurnReceipt = {
  state: 'completed',
  chatId: CHAT_ID,
  turnId: TURN_ID,
  acceptedAt: new Date().toISOString(),
  settledAt: new Date().toISOString(),
  output: { availability: 'available', completeness: 'complete', assistantMessages: ['Done'] },
};

describe('pollTurnReceipt', () => {
  test('backs off while pending and returns the correlated terminal receipt', async () => {
    let requests = 0;
    const delays: number[] = [];
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        return requests === 1
          ? { state: 'pending', chatId: CHAT_ID, turnId: TURN_ID, acceptedAt: new Date().toISOString() }
          : completed;
      },
      async verifyRuntime() { return true; },
    };
    expect(await pollTurnReceipt(client, CHAT_ID, TURN_ID, undefined, {
      delay: async (milliseconds) => { delays.push(milliseconds); },
    })).toBe(completed);
    expect(delays).toEqual([250]);
  });

  test('recovers a transient receipt failure after verifying the runtime', async () => {
    let requests = 0;
    let verifications = 0;
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        if (requests === 1) throw new GarconTransportError('receipt polling', 'reset');
        return completed;
      },
      async verifyRuntime() {
        verifications += 1;
        return true;
      },
    };
    await pollTurnReceipt(client, CHAT_ID, TURN_ID, undefined, { delay: async () => undefined });
    expect(verifications).toBe(1);
  });

  test('fails explicitly when a new server instance occupies the URL', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() {
        throw new GarconTransportError('receipt polling', 'reset');
      },
      async verifyRuntime() { return false; },
    };
    try {
      await pollTurnReceipt(client, CHAT_ID, TURN_ID, undefined, { delay: async () => undefined });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).phase).toBe('transport recovery');
      expect((error as CliError).exitCode).toBe(3);
    }
  });

  test('recognizes authentication loss caused by a server restart', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() {
        throw new GarconHttpError('authentication', 'invalid token', 401, null, false);
      },
      async verifyRuntime() { return false; },
    };
    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, undefined, {
      delay: async () => undefined,
    })).rejects.toThrow('restarted');
  });

  test('rejects a receipt for a different turn', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() { return { ...completed, turnId: 'other' }; },
      async verifyRuntime() { return true; },
    };
    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID)).rejects.toThrow('different turn');
  });
});
