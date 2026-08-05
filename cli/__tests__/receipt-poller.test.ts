import { describe, expect, test } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { CliError } from '../errors.js';
import { GarconHttpError, GarconTransportError } from '../garcon-client.js';
import {
  pollExistingTurnReceipt,
  pollTurnReceipt,
  type ReceiptClient,
} from '../receipt-poller.js';

const CHAT_ID = '1785337200123456';
const TURN_ID = 'turn-1';
const CLIENT_REQUEST_ID = 'request-1';
const TIMESTAMP = '2026-07-31T12:00:00.000Z';
const completed: AgentTurnReceipt = {
  state: 'completed',
  chatId: CHAT_ID,
  turnId: TURN_ID,
  clientRequestId: CLIENT_REQUEST_ID,
  acceptedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  settledAt: TIMESTAMP,
  output: { availability: 'available', completeness: 'complete', assistantMessages: ['Done'] },
};
const pending: AgentTurnReceipt = {
  state: 'pending',
  chatId: CHAT_ID,
  turnId: TURN_ID,
  clientRequestId: CLIENT_REQUEST_ID,
  acceptedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

describe('pollTurnReceipt', () => {
  test('pins the first existing receipt client request identity', async () => {
    let requests = 0;
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        return requests === 1 ? pending : completed;
      },
      async verifyRuntime() { return true; },
    };

    expect(await pollExistingTurnReceipt(client, CHAT_ID, TURN_ID, undefined, {
      delay: async () => undefined,
    })).toBe(completed);
    expect(requests).toBe(2);
  });

  test('rejects a client request identity change after reattachment', async () => {
    let requests = 0;
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        return requests === 1
          ? pending
          : { ...completed, clientRequestId: 'different-request' };
      },
      async verifyRuntime() { return true; },
    };

    await expect(pollExistingTurnReceipt(client, CHAT_ID, TURN_ID, undefined, {
      delay: async () => undefined,
    })).rejects.toThrow('different turn');
  });

  test('backs off while pending and returns the correlated terminal receipt', async () => {
    let requests = 0;
    const delays: number[] = [];
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        return requests === 1 ? pending : completed;
      },
      async verifyRuntime() { return true; },
    };
    expect(await pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
      delay: async (milliseconds) => { delays.push(milliseconds); },
      random: () => 0.5,
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
    await pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
      delay: async () => undefined,
    });
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
      await pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
        delay: async () => undefined,
      });
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
    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
      delay: async () => undefined,
    })).rejects.toThrow('restarted');
  });

  test('rejects a receipt for a different turn', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() { return { ...completed, turnId: 'other' }; },
      async verifyRuntime() { return true; },
    };
    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID))
      .rejects.toThrow('different turn');
  });

  test('rejects a receipt for a different client request', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() { return { ...completed, clientRequestId: 'other' }; },
      async verifyRuntime() { return true; },
    };
    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID))
      .rejects.toThrow('different turn');
  });

  test('retries 408 and 425 responses and honors Retry-After', async () => {
    let requests = 0;
    const delays: number[] = [];
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        if (requests === 1) {
          throw new GarconHttpError(
            'receipt polling',
            'too early',
            425,
            null,
            false,
            3_000,
          );
        }
        if (requests === 2) {
          throw new GarconHttpError('receipt polling', 'timeout', 408, null, false);
        }
        return completed;
      },
      async verifyRuntime() { return true; },
    };

    await pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
      delay: async (milliseconds) => { delays.push(milliseconds); },
      random: () => 0.5,
    });

    expect(delays).toEqual([3_000, 500]);
  });

  test('bounds a continuous outage even while runtime verification succeeds', async () => {
    let requests = 0;
    const client: ReceiptClient = {
      async getTurnReceipt() {
        requests += 1;
        throw new GarconHttpError('receipt polling', 'unavailable', 503, null, true);
      },
      async verifyRuntime() { return true; },
    };

    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
      delay: async () => undefined,
    })).rejects.toThrow('accepted chat may still be running');
    expect(requests).toBe(8);
  });

  test('classifies a missing receipt against the current runtime identity', async () => {
    const missing = new GarconHttpError(
      'receipt polling',
      'missing',
      404,
      'TURN_RECEIPT_NOT_FOUND',
      false,
    );
    const currentClient: ReceiptClient = {
      async getTurnReceipt() { throw missing; },
      async verifyRuntime() { return true; },
    };
    const restartedClient: ReceiptClient = {
      async getTurnReceipt() { throw missing; },
      async verifyRuntime() { return false; },
    };

    await expect(pollTurnReceipt(currentClient, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID))
      .rejects.toThrow('receipt is unavailable');
    await expect(pollTurnReceipt(restartedClient, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID))
      .rejects.toThrow('restarted');
  });

  test('directs expired results to the complete Garcon transcript', async () => {
    const client: ReceiptClient = {
      async getTurnReceipt() {
        throw new GarconHttpError(
          'receipt polling',
          'expired',
          410,
          'TURN_RESULT_EXPIRED',
          false,
        );
      },
      async verifyRuntime() { return true; },
    };

    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID))
      .rejects.toThrow('view the complete transcript in Garcon');
  });

  test('bounds recovery by elapsed time as well as failure count', async () => {
    let currentTime = 0;
    const delays: number[] = [];
    const client: ReceiptClient = {
      async getTurnReceipt() {
        throw new GarconHttpError('receipt polling', 'unavailable', 503, null, true, 5_000);
      },
      async verifyRuntime() { return true; },
    };

    await expect(pollTurnReceipt(client, CHAT_ID, TURN_ID, CLIENT_REQUEST_ID, undefined, {
      now: () => currentTime,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        currentTime += milliseconds;
      },
      random: () => 0.5,
    })).rejects.toThrow('accepted chat may still be running');
    expect(delays.every((milliseconds) => milliseconds <= 5_000)).toBe(true);
    expect(currentTime).toBeLessThan(30_000);
  });
});
