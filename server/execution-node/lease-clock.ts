export interface LeaseClockReading {
  readonly elapsedMs: number;
  readonly discontinuity: boolean;
}

/** Has one consumer; sharing a clock can consume a discontinuity before its authority owner observes it. */
export interface LeaseClock {
  read(): LeaseClockReading;
}

const MAX_CLOCK_DIVERGENCE_MS = 1_000;

/** Expires authority conservatively when suspension or clock adjustment makes elapsed time uncertain. */
export class SuspendAwareLeaseClock implements LeaseClock {
  #previous: { monotonic: number; wall: number } | null = null;
  #elapsedMs = 0;

  constructor(
    private readonly monotonic = () => performance.now(),
    private readonly wall = () => Date.now(),
  ) {}

  read(): LeaseClockReading {
    const monotonic = this.monotonic();
    const wall = this.wall();
    const previous = this.#previous;
    if (!Number.isFinite(monotonic) || monotonic < 0 || !Number.isFinite(wall)) {
      this.#previous = null;
      return { elapsedMs: NaN, discontinuity: true };
    }
    this.#previous = { monotonic, wall };
    if (previous === null) {
      this.#elapsedMs = Math.max(this.#elapsedMs, monotonic);
      return { elapsedMs: this.#elapsedMs, discontinuity: false };
    }
    const monotonicDelta = monotonic - previous.monotonic;
    const wallDelta = wall - previous.wall;
    // Tolerated divergence still counts; repeated short suspensions cannot extend authority.
    this.#elapsedMs += Math.max(0, monotonicDelta, wallDelta);
    return {
      elapsedMs: this.#elapsedMs,
      discontinuity: monotonicDelta < 0 || wallDelta < 0
        || Math.abs(wallDelta - monotonicDelta) > MAX_CLOCK_DIVERGENCE_MS,
    };
  }
}
