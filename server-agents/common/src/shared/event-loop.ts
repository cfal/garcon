// Resolves after pending socket and timer callbacks have had a turn, so bulk work split into
// bounded steps cannot starve WebSocket liveness or other chats. A resolved promise alone
// would continue in the microtask queue without letting any I/O run.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const STEP_BUDGET_MS = 10;

// Splits one operation's whole-history work into steps bounded by elapsed time rather than
// item count, because one transcript message can cost a thousand times another. An operation
// shares one instance across its consecutive passes, so their budgets cannot stack into one
// long stretch.
export class EventLoopSteps {
  #stepEnd = performance.now() + STEP_BUDGET_MS;

  // Whether the current step has used its budget.
  get due(): boolean {
    return performance.now() >= this.#stepEnd;
  }

  // Yields to the event loop once the current step has used its budget. Loops over an
  // asynchronous stream need this too: an async generator that yields without awaiting I/O
  // only chains microtasks, so neither side gives sockets a turn.
  async next(): Promise<void> {
    if (!this.due) return;
    await yieldToEventLoop();
    this.#stepEnd = performance.now() + STEP_BUDGET_MS;
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
export function forEachInSteps<T>(items: Iterable<T>, visit: (item: T) => void): Promise<void> {
  return new EventLoopSteps().forEach(items, visit);
}
