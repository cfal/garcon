import type { AgentGoalControlHandoff } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '../shared/event-emitter-runtime.js';
import type { AgentRuntimePublisher } from './runtime-events.js';

export interface TrackedRun {
  readonly runId: string;
  readonly chatId: string;
  // Captured when the run was registered, so an event correlated to this run reaches the
  // transcript that run was started against rather than whichever one is current now.
  readonly publish: AgentRuntimePublisher;
}

// Routes outlive the runs that created them because a provider keeps flushing after a turn ends,
// and that content is still the transcript's while its sink is open. They are bounded per chat
// so a long-lived process cannot accumulate routes indefinitely.
const RETAINED_RUNS_PER_CHAT = 8;

export class AgentRunTracker {
  readonly #runs = new Map<string, TrackedRun>();
  readonly #order = new Map<string, string[]>();
  readonly #active = new Map<string, string>();
  readonly #latest = new Map<string, string>();

  register(chatId: string, runId: string, publish: AgentRuntimePublisher): void {
    this.#runs.set(runId, { runId, chatId, publish });
    const retained = [...(this.#order.get(chatId) ?? []).filter((id) => id !== runId), runId];
    while (retained.length > RETAINED_RUNS_PER_CHAT) {
      const evicted = retained.shift();
      if (evicted) this.#runs.delete(evicted);
    }
    this.#order.set(chatId, retained);
    this.#active.set(chatId, runId);
    this.#latest.set(chatId, runId);
  }

  // A goal-control successor continues the operation its predecessor started, so it inherits
  // that route. The publisher passed in covers the case where there is no predecessor to
  // inherit from, which would otherwise leave the successor unroutable.
  handoff(
    chatId: string,
    predecessor: string | null,
    successor: string,
    publish: AgentRuntimePublisher,
    downstream: AgentGoalControlHandoff,
  ): AgentGoalControlHandoff {
    const validate = () => {
      if ((this.#active.get(chatId) ?? null) !== predecessor) {
        throw new Error(`Cannot hand off run for chat ${chatId} after its active run changed`);
      }
    };
    validate();
    return {
      validate: () => {
        validate();
        downstream.validate();
      },
      commit: () => {
        const inherited = predecessor === null ? null : this.#runs.get(predecessor);
        this.register(chatId, successor, inherited?.publish ?? publish);
        downstream.commit();
      },
    };
  }

  current(chatId: string): string | null {
    return this.#active.get(chatId) ?? null;
  }

  // Resolves the run that produced an event from the provider's own name for it. Content the
  // provider flushes after its turn ends carries no such name, so it follows the source's most
  // recent operation instead - never a lookup of what the chat is doing now. If the transcript
  // was replaced in between, that operation's sink is already closed and rejects the event,
  // which is the whole point of routing through a captured capability.
  correlate(chatId: string, metadata?: RuntimeEventMetadata): TrackedRun | null {
    const named = metadata?.turnId ?? metadata?.clientRequestId ?? null;
    if (named) return this.#runs.get(named) ?? null;
    const latest = this.#latest.get(chatId);
    return latest ? this.#runs.get(latest) ?? null : null;
  }

  finish(chatId: string, runId: string): void {
    // The run is no longer active, but its route stays: the provider may still be flushing.
    if (this.#active.get(chatId) === runId) this.#active.delete(chatId);
  }
}
