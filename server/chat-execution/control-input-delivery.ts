import { DomainError } from '../lib/domain-error.ts';
import type { CapturedSteerTarget } from './types.ts';

const MAX_CONTROL_DISPATCH_ATTEMPTS = 3;

interface ControlInputDeliveryOptions {
  captureTarget(chatId: string): CapturedSteerTarget | null;
  deliverSteer(
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
  ): Promise<void>;
  scheduleRun(
    chatId: string,
    content: string,
    transcriptViewId: string,
    onReserved: (turnId: string) => void,
    onOwnershipAcquired: () => void,
  ): Promise<void>;
  watchRouteChange(chatId: string): ControlRouteChangeWatch;
}

interface ControlRouteChangeWatch {
  readonly promise: Promise<void>;
  cancel(): void;
}

export class ControlInputBlockedError extends DomainError {
  constructor() {
    super(
      'SESSION_BUSY',
      'Server control input is blocked by paused or pending queue work',
      409,
      true,
    );
    this.name = 'ControlInputBlockedError';
  }
}

export class ControlInputDelivery {
  constructor(private readonly options: ControlInputDeliveryOptions) {}

  async deliver(
    chatId: string,
    content: string,
    transcriptViewId: string,
    signal: AbortSignal,
    onHiddenRun: (turnId: string) => void,
  ): Promise<void> {
    let lastError: unknown;
    let firstUnsupported: DomainError | null = null;
    let pendingTarget: CapturedSteerTarget | null = null;
    let runRouteAttempted = false;

    for (let attempt = 0; attempt < MAX_CONTROL_DISPATCH_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      const finalAttempt = attempt === MAX_CONTROL_DISPATCH_ATTEMPTS - 1;
      const target = pendingTarget ?? this.options.captureTarget(chatId);
      pendingTarget = null;
      if (target) {
        try {
          await this.options.deliverSteer(chatId, content, transcriptViewId, target);
          return;
        } catch (error) {
          if (!runRouteAttempted) {
            firstUnsupported ??= findDomainError(error, 'OPERATION_UNSUPPORTED');
          }
          if (!isSafeControlRouteFlip(error)) {
            throwPreferredError(error, firstUnsupported, signal);
          }
          lastError = error;
          if (finalAttempt) continue;
          try {
            await waitForAttemptSettlement(target, signal);
          } catch (settlementError) {
            throwPreferredError(settlementError, firstUnsupported, signal);
          }
          continue;
        }
      }

      const routeChange = finalAttempt ? null : this.options.watchRouteChange(chatId);
      let runOwnershipAcquired = false;
      try {
        try {
          runRouteAttempted = true;
          firstUnsupported = null;
          await this.options.scheduleRun(
            chatId,
            content,
            transcriptViewId,
            onHiddenRun,
            () => { runOwnershipAcquired = true; },
          );
          return;
        } catch (error) {
          if (findControlInputBlockedError(error)) {
            throwPreferredError(error, firstUnsupported, signal);
          }
          if (!findDomainError(error, 'SESSION_BUSY')) {
            throwPreferredError(error, firstUnsupported, signal);
          }
          lastError = error;
          pendingTarget = this.options.captureTarget(chatId);
          if (!pendingTarget && !runOwnershipAcquired && routeChange) {
            try {
              await waitAbortably(routeChange.promise, signal);
            } catch (routeError) {
              throwPreferredError(routeError, firstUnsupported, signal);
            }
            pendingTarget = this.options.captureTarget(chatId);
          }
        }
      } finally {
        routeChange?.cancel();
      }
    }

    signal.throwIfAborted();
    if (firstUnsupported) throw firstUnsupported;
    throw new DomainError(
      'SESSION_BUSY',
      'No server control input delivery route became available',
      409,
      true,
      { cause: lastError },
    );
  }
}

// Hidden control delivery may also fall back after capability, steerability, or
// confirmed-not-sent failures because no user row has been committed for reuse.
function isSafeControlRouteFlip(error: unknown): boolean {
  return Boolean(
    findDomainError(error, 'STEER_TURN_UNAVAILABLE')
    || findDomainError(error, 'STEER_TURN_CHANGED')
    || findDomainError(error, 'STEER_TURN_NOT_STEERABLE')
    || findDomainError(error, 'OPERATION_UNSUPPORTED')
    || findDomainError(error, 'STEER_NOT_DELIVERED'),
  );
}

function findDomainError(error: unknown, code: DomainError['code']): DomainError | null {
  if (error instanceof DomainError) return error.code === code ? error : null;
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const match = findDomainError(cause, code);
      if (match) return match;
    }
  }
  return null;
}

function findControlInputBlockedError(error: unknown): ControlInputBlockedError | null {
  if (error instanceof ControlInputBlockedError) return error;
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const match = findControlInputBlockedError(cause);
      if (match) return match;
    }
  }
  return null;
}

function throwPreferredError(
  error: unknown,
  firstUnsupported: DomainError | null,
  signal: AbortSignal,
): never {
  signal.throwIfAborted();
  throw firstUnsupported ?? error;
}

function waitForAttemptSettlement(
  target: CapturedSteerTarget,
  signal: AbortSignal,
): Promise<void> {
  return waitAbortably(target.attempt.waitUntilSettled(), signal);
}

function waitAbortably(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
