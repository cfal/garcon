import type {
  AgentSessionConfigurationCommitResult,
  AgentSessionConfigurationPreparation,
  AgentSessionConfigurationPrepareRequest,
  AgentSessionConfigurationRejection,
  AgentSessionConfigurationTarget,
  AgentSessionConfigurationUpdates,
} from '@garcon/server-agent-interface';

export interface CapturedSessionConfiguration {
  validate(): boolean;
  /** Revalidates immediately before each mutation, including after a provider's internal queue. */
  deliver(beforeMutation: () => void): Promise<'applied' | 'not-required'>;
}

interface PendingConfiguration {
  readonly captured: CapturedSessionConfiguration;
  readonly signal: AbortSignal;
  detach(): void;
}

export class SessionConfigurationNotDeliveredError extends Error {
  constructor(readonly reason: AgentSessionConfigurationRejection['reason'], options?: ErrorOptions) {
    super('Session configuration was not delivered', options);
  }
}

/** Keeps native target captures private and consumes them once before delivery. */
export class SessionConfigurationPreparations implements AgentSessionConfigurationUpdates {
  readonly #pending = new WeakMap<AgentSessionConfigurationTarget, PendingConfiguration>();

  constructor(private readonly capture: (
    request: AgentSessionConfigurationPrepareRequest,
  ) => CapturedSessionConfiguration | AgentSessionConfigurationRejection | null) {}

  async prepare(input: AgentSessionConfigurationPrepareRequest): Promise<AgentSessionConfigurationPreparation> {
    input.signal.throwIfAborted();
    const request = { ...structuredClone({ expected: input.expected, previous: input.previous, next: input.next }), signal: input.signal };
    const captured = this.capture(request);
    request.signal.throwIfAborted();
    if (!captured) return { kind: 'not-required' };
    if ('kind' in captured) return captured;
    if (!captured.validate()) return { kind: 'rejected', reason: 'target-changed' };
    const target = Object.freeze({});
    const cancel = () => this.cancel(target);
    this.#pending.set(target, { captured, signal: request.signal,
      detach: () => request.signal.removeEventListener('abort', cancel) });
    request.signal.addEventListener('abort', cancel, { once: true });
    return { kind: 'prepared', target };
  }

  async commit(target: AgentSessionConfigurationTarget, signal: AbortSignal): Promise<AgentSessionConfigurationCommitResult> {
    const pending = this.#pending.get(target);
    if (!pending) return { kind: 'rejected', reason: 'target-changed' };
    this.#pending.delete(target);
    pending.detach();
    let mutated = false;
    const validate = () => {
      if (signal.aborted || pending.signal.aborted) throw new SessionConfigurationNotDeliveredError('cancelled');
      if (!pending.captured.validate()) throw new SessionConfigurationNotDeliveredError('target-changed');
    };
    try {
      validate();
      const result = await pending.captured.deliver(() => {
        validate();
        mutated = true;
      });
      if (result === 'applied') return { kind: mutated ? 'applied' : 'unknown' };
      if (mutated) return { kind: 'unknown' };
      validate();
      return { kind: 'not-required' };
    } catch (error) {
      if (mutated) return { kind: 'unknown' };
      if (error instanceof SessionConfigurationNotDeliveredError) return { kind: 'rejected', reason: error.reason };
      throw error;
    }
  }

  cancel(target: AgentSessionConfigurationTarget): void {
    const pending = this.#pending.get(target);
    if (!pending) return;
    this.#pending.delete(target);
    pending.detach();
  }
}
