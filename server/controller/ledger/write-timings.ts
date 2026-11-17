import type { Database } from 'bun:sqlite';
import { trackActivity } from '../../common/event-loop-stalls.js';
import { createLogger } from '../../common/log.js';
import { runTransaction } from './sqlite-operations.js';

const SLOW_WRITE_MS = 50;
const logger = createLogger('ledger:write');
type WritePhase = 'prepare' | 'encode' | 'validate' | 'write' | 'begin' | 'statements' | 'commit' | 'rollback' | 'complete';
type WriteContext = Record<string, string | number>;

interface PhaseTiming {
  wallMs: number;
  processCpuMs: number;
}

// CPU usage is process-wide, including Workers; it is not attribution to this thread.
export class LedgerWriteTimings {
  readonly #startedAt = performance.now();
  readonly #phases: Partial<Record<WritePhase, PhaseTiming>> = {};
  #phase: WritePhase = 'prepare';
  #phaseStartedAt = this.#startedAt;
  #cpu = process.cpuUsage();
  readonly #finishActivity: () => void;

  constructor(readonly operation: string) {
    this.#finishActivity = trackActivity(operation);
  }

  phase(phase: WritePhase): void {
    this.#record();
    this.#phase = phase;
  }

  finish(context: WriteContext): void {
    this.#record();
    this.#finishActivity();
    const wallMs = performance.now() - this.#startedAt;
    if (wallMs < SLOW_WRITE_MS) return;
    try {
      logger.warn('Slow synchronous write', JSON.stringify({
        operation: this.operation, ...context, wallMs, phases: this.#phases,
      }));
    } catch {
      // Diagnostic output must not replace a committed result or the original storage failure.
    }
  }

  #record(): void {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const timing = this.#phases[this.#phase] ??= { wallMs: 0, processCpuMs: 0 };
    timing.wallMs += now - this.#phaseStartedAt;
    timing.processCpuMs += (cpu.user - this.#cpu.user + cpu.system - this.#cpu.system) / 1000;
    this.#phaseStartedAt = now;
    this.#cpu = cpu;
  }
}

export function measureLedgerWrite<T>(
  operation: string,
  context: WriteContext,
  work: (timings: LedgerWriteTimings) => T,
): T {
  const timings = new LedgerWriteTimings(operation);
  try {
    return work(timings);
  } finally {
    timings.finish(context);
  }
}

export function measureLedgerTransaction<T>(
  operation: string,
  context: WriteContext,
  db: Database,
  work: () => T,
): T {
  return measureLedgerWrite(operation, context, (timings) => runTransaction(db, work, timings));
}
