import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { CliError } from './errors.js';
import { GarconHttpError, GarconTransportError } from './garcon-client.js';

const INITIAL_POLL_DELAY_MS = 250;
const MAX_POLL_DELAY_MS = 2_000;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 8;
const RUNTIME_RECHECK_INTERVAL_MS = 30_000;

export interface ReceiptClient {
  getTurnReceipt(chatId: string, turnId: string, signal?: AbortSignal): Promise<AgentTurnReceipt>;
  verifyRuntime(signal?: AbortSignal): Promise<boolean>;
}

export interface ReceiptPollerDependencies {
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  return error instanceof GarconTransportError
    || error instanceof CliError && error.phase === 'runtime verification'
    || error instanceof GarconHttpError && (
      error.retryable
      || error.status === 429
      || error.status === 502
      || error.status === 503
      || error.status === 504
    );
}

export async function pollTurnReceipt(
  client: ReceiptClient,
  chatId: string,
  turnId: string,
  signal?: AbortSignal,
  dependencies: ReceiptPollerDependencies = {},
): Promise<AgentTurnReceipt> {
  const delay = dependencies.delay ?? wait;
  const now = dependencies.now ?? Date.now;
  let pollDelay = INITIAL_POLL_DELAY_MS;
  let consecutiveFailures = 0;
  let lastRuntimeCheck = now();

  while (true) {
    signal?.throwIfAborted();
    try {
      const receipt = await client.getTurnReceipt(chatId, turnId, signal);
      consecutiveFailures = 0;
      if (receipt.chatId !== chatId || receipt.turnId !== turnId) {
        throw new CliError('receipt polling', 'server returned a receipt for a different turn', 3);
      }
      if (receipt.state !== 'pending') return receipt;

      if (now() - lastRuntimeCheck >= RUNTIME_RECHECK_INTERVAL_MS) {
        if (!await client.verifyRuntime(signal)) {
          throw new CliError('transport recovery', 'Garcon restarted while the turn was running', 3);
        }
        lastRuntimeCheck = now();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof GarconHttpError && (error.status === 401 || error.status === 403)) {
        try {
          if (!await client.verifyRuntime(signal)) {
            throw new CliError('transport recovery', 'Garcon restarted while the turn was running', 3);
          }
        } catch (verificationError) {
          if (verificationError instanceof CliError && verificationError.phase === 'transport recovery') {
            throw verificationError;
          }
        }
        throw error;
      }
      if (!isRetryable(error)) throw error;
      consecutiveFailures += 1;
      try {
        if (!await client.verifyRuntime(signal)) {
          throw new CliError('transport recovery', 'Garcon restarted while the turn was running', 3);
        }
        lastRuntimeCheck = now();
      } catch (verificationError) {
        if (verificationError instanceof CliError && verificationError.phase === 'transport recovery') {
          throw verificationError;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
          throw new CliError(
            'transport recovery',
            'Garcon remained unreachable while waiting for the turn result',
            3,
            { cause: error },
          );
        }
      }
    }

    await delay(pollDelay, signal);
    pollDelay = Math.min(MAX_POLL_DELAY_MS, pollDelay * 2);
  }
}
