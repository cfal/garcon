// Resolves after pending socket and timer callbacks have had a turn, so bulk work split into
// bounded steps cannot starve WebSocket liveness or other chats. A resolved promise alone
// would continue in the microtask queue without letting any I/O run.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const STEP_BUDGET_MS = 10;
const SLOW_STEP_MS = 50;

export type SlowStepReporter = (operation: string, stepMs: number) => void;

let slowStepReporter: SlowStepReporter = () => {};

// Routes reports of steps that held the event loop past the slow-step limit to the process's
// log. The stall monitor detects a stall only after the work has returned, so it cannot name
// the work; a step can.
export function reportSlowSteps(reporter: SlowStepReporter): () => void {
  slowStepReporter = reporter;
  return () => {
    if (slowStepReporter === reporter) slowStepReporter = () => {};
  };
}

// Splits one operation's whole-history work into steps bounded by elapsed time rather than
// item count, because one transcript message can cost a thousand times another. An operation
// shares one instance across its consecutive passes, so their budgets cannot stack into one
// long stretch.
export class EventLoopSteps {
  readonly #operation: string;
  #stepStart = performance.now();
  #stepEnd = this.#stepStart + STEP_BUDGET_MS;
  #holding = holdingProbe();

  constructor(operation: string) {
    this.#operation = operation;
  }

  // Whether the current step has used its budget.
  get due(): boolean {
    return performance.now() >= this.#stepEnd;
  }

  // Yields to the event loop once the current step has used its budget. Loops over an
  // asynchronous stream need this too: an async generator that yields without awaiting I/O
  // only chains microtasks, so neither side gives sockets a turn.
  async next(): Promise<void> {
    if (!this.due) return;
    const stepMs = performance.now() - this.#stepStart;
    // A step that awaited I/O let the event loop run and the probe fire, so only a step
    // that held the loop throughout is reported.
    if (stepMs >= SLOW_STEP_MS && this.#holding.held) slowStepReporter(this.#operation, stepMs);
    await yieldToEventLoop();
    this.#stepStart = performance.now();
    this.#stepEnd = this.#stepStart + STEP_BUDGET_MS;
    this.#holding = holdingProbe();
  }

  // Visits every item, yielding whenever the current step has used its budget.
  async forEach<T>(items: Iterable<T>, visit: (item: T) => void): Promise<void> {
    for (const item of items) {
      visit(item);
      if (this.due) await this.next();
    }
  }
}

// Runs a single pass in its own steps.
export function forEachInSteps<T>(
  operation: string,
  items: Iterable<T>,
  visit: (item: T) => void,
): Promise<void> {
  return new EventLoopSteps(operation).forEach(items, visit);
}

// Stays held until the event loop next runs timers, which it cannot do while a step holds it.
function holdingProbe(): { held: boolean } {
  const probe = { held: true };
  setTimeout(() => { probe.held = false; }, 0).unref();
  return probe;
}
