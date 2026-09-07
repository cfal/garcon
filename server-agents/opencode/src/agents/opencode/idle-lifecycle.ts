import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { OpenCodeSession } from './turn-events.js';

const DEFAULT_OPENCODE_IDLE_RETIREMENT_DELAY_MS = 30_000;
const DEFAULT_OPENCODE_IDLE_RETIREMENT_CHECK_INTERVAL_MS = 5_000;

interface OpenCodeIdleLifecycleOptions {
  readonly logger: AgentLogger;
  readonly sessions: () => Iterable<[string, OpenCodeSession]>;
  readonly purgeSession: (sessionId: string) => void;
  readonly hasInstance: () => boolean;
  readonly hasStartup: () => boolean;
  readonly endpointIdle: () => boolean;
  readonly routesIdle: () => boolean;
  readonly decisionsIdle: () => boolean;
  readonly hasPendingTurnWaiters: () => boolean;
  readonly isShuttingDown: () => boolean;
  readonly runTransition: (operation: () => Promise<boolean>) => Promise<boolean>;
  readonly invalidateModels: () => void;
  readonly closeInstance: () => void;
  readonly now: () => number;
  readonly retirementDelayMs?: number;
  readonly retirementCheckIntervalMs?: number;
}

export class OpenCodeIdleLifecycle {
  readonly #options: OpenCodeIdleLifecycleOptions;
  readonly #sessionPurger: IdleSessionPurger<OpenCodeSession>;
  readonly #retirementDelayMs: number;
  readonly #retirementCheckIntervalMs: number;
  #retirementTimer: ReturnType<typeof setInterval> | null = null;
  #retirementCheck: Promise<boolean> | null = null;
  #lastEndpointActivityAt: number;

  constructor(options: OpenCodeIdleLifecycleOptions) {
    this.#options = options;
    this.#retirementDelayMs = options.retirementDelayMs
      ?? DEFAULT_OPENCODE_IDLE_RETIREMENT_DELAY_MS;
    this.#retirementCheckIntervalMs = options.retirementCheckIntervalMs
      ?? DEFAULT_OPENCODE_IDLE_RETIREMENT_CHECK_INTERVAL_MS;
    this.#lastEndpointActivityAt = options.now();
    this.#sessionPurger = new IdleSessionPurger({
      sessions: options.sessions,
      isRunning: (session) => (
        session.status === 'running'
        || session.providerWorkRequiresQuiescence
        || session.pendingSteeringRevertMessageId !== null
      ),
      lastActivityAt: (session) => session.lastActivityAt,
      purge: options.purgeSession,
    });
  }

  recordActivity(): void {
    this.#lastEndpointActivityAt = this.#options.now();
  }

  closeInstanceIfIdle(): boolean {
    const hasRunningSession = Array.from(this.#options.sessions())
      .some(([, session]) => session.status === 'running');
    if (hasRunningSession || !this.#options.endpointIdle()) return false;
    this.#options.closeInstance();
    return true;
  }

  start(): void {
    this.#sessionPurger.start();
    if (this.#retirementTimer) return;
    this.#retirementTimer = setInterval(async () => {
      try {
        await this.#retireInstance();
      } catch (error) {
        this.#options.logger.error('OpenCode idle retirement check failed', {
          error: errorMessage(error),
        });
      }
    }, this.#retirementCheckIntervalMs);
    this.#retirementTimer.unref?.();
  }

  stop(): void {
    this.#sessionPurger.stop();
    if (!this.#retirementTimer) return;
    clearInterval(this.#retirementTimer);
    this.#retirementTimer = null;
  }

  #retireInstance(): Promise<boolean> {
    if (this.#retirementCheck) return this.#retirementCheck;
    let check!: Promise<boolean>;
    check = this.#options.runTransition(async () => {
      if (
        this.#options.isShuttingDown()
        || this.#options.now() - this.#lastEndpointActivityAt < this.#retirementDelayMs
        || !this.#canRetireInstance()
      ) return false;
      this.#options.invalidateModels();
      this.#options.logger.info('Retiring idle OpenCode server process');
      this.#options.closeInstance();
      return true;
    }).finally(() => {
      if (this.#retirementCheck === check) this.#retirementCheck = null;
    });
    this.#retirementCheck = check;
    return check;
  }

  #canRetireInstance(): boolean {
    if (
      !this.#options.hasInstance()
      || this.#options.hasStartup()
      || !this.#options.endpointIdle()
      || !this.#options.routesIdle()
      || !this.#options.decisionsIdle()
      || this.#options.hasPendingTurnWaiters()
    ) return false;
    // Process retirement quiesces settled sessions; closeInstance clears their purge fence.
    return Array.from(this.#options.sessions()).every(([, session]) => (
      session.status !== 'running'
      && !session.aborting
      && session.activeSteeringDeliveries === 0
      && session.deferredTerminal === null
    ));
  }
}
