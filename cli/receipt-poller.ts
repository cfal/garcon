import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { abortableDelay } from './abortable-delay.js';
import { CliError } from './errors.js';
import { GarconHttpError, GarconTransportError } from './garcon-client.js';

const INITIAL_POLL_DELAY_MS = 250;
const MAX_POLL_DELAY_MS = 2_000;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 8;
const MAX_TRANSPORT_RECOVERY_MS = 30_000;
const RUNTIME_RECHECK_INTERVAL_MS = 30_000;

export interface ReceiptClient {
  getTurnReceipt(chatId: string, turnId: string, signal?: AbortSignal): Promise<AgentTurnReceipt>;
  verifyRuntime(signal?: AbortSignal): Promise<boolean>;
}

export interface ReceiptPollerDependencies {
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

function isRetryable(error: unknown): boolean {
  return error instanceof GarconTransportError
    || error instanceof CliError && error.phase === 'runtime verification'
    || error instanceof GarconHttpError && (
      error.retryable
      || error.status === 408
      || error.status === 425
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
  clientRequestId: string,
  signal?: AbortSignal,
  dependencies: ReceiptPollerDependencies = {},
): Promise<AgentTurnReceipt> {
  const delay = dependencies.delay ?? abortableDelay;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  let pollDelay = INITIAL_POLL_DELAY_MS;
  let consecutiveFailures = 0;
  let recoveryStartedAt: number | null = null;
  let lastRuntimeCheck = now();

  while (true) {
    signal?.throwIfAborted();
    let retryAfterMs = 0;
    try {
      const receipt = await client.getTurnReceipt(chatId, turnId, signal);
      consecutiveFailures = 0;
      recoveryStartedAt = null;
      if (
        receipt.chatId !== chatId
        || receipt.turnId !== turnId
        || receipt.clientRequestId !== clientRequestId
      ) {
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
      if (
        error instanceof GarconHttpError
        && error.status === 404
        && error.errorCode === 'TURN_RECEIPT_NOT_FOUND'
      ) {
        let sameRuntime: boolean;
        try {
          sameRuntime = await client.verifyRuntime(signal);
        } catch (verificationError) {
          throw new CliError(
            'transport recovery',
            'the accepted chat may still be running, but Garcon could not be verified after its turn receipt disappeared',
            3,
            { cause: verificationError },
          );
        }
        if (!sameRuntime) {
          throw new CliError('transport recovery', 'Garcon restarted while the turn was running', 3);
        }
        throw new CliError(
          'receipt polling',
          'the accepted turn receipt is unavailable on the verified Garcon instance',
          3,
          { cause: error },
        );
      }
      if (
        error instanceof GarconHttpError
        && error.status === 410
        && error.errorCode === 'TURN_RESULT_EXPIRED'
      ) {
        throw new CliError(
          'receipt polling',
          'the turn result expired before the CLI could read it; view the complete transcript in Garcon',
          3,
          { cause: error },
        );
      }
      if (!isRetryable(error)) throw error;
      consecutiveFailures += 1;
      recoveryStartedAt ??= now();
      retryAfterMs = error instanceof GarconHttpError ? error.retryAfterMs ?? 0 : 0;
      try {
        if (!await client.verifyRuntime(signal)) {
          throw new CliError('transport recovery', 'Garcon restarted while the turn was running', 3);
        }
        lastRuntimeCheck = now();
      } catch (verificationError) {
        if (verificationError instanceof CliError && verificationError.phase === 'transport recovery') {
          throw verificationError;
        }
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
        throw recoveryFailure(error);
      }
    }

    const jitteredDelay = Math.min(
      MAX_POLL_DELAY_MS,
      Math.round(pollDelay * (0.9 + random() * 0.2)),
    );
    const nextDelay = Math.max(jitteredDelay, retryAfterMs);
    if (
      recoveryStartedAt !== null
      && now() + nextDelay - recoveryStartedAt >= MAX_TRANSPORT_RECOVERY_MS
    ) {
      throw recoveryFailure();
    }
    await delay(nextDelay, signal);
    pollDelay = Math.min(MAX_POLL_DELAY_MS, pollDelay * 2);
  }
}

function recoveryFailure(cause?: unknown): CliError {
  return new CliError(
    'transport recovery',
    'the accepted chat may still be running in Garcon, but its turn result could not be reached',
    3,
    cause === undefined ? undefined : { cause },
  );
}
