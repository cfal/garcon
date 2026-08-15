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

export class AgentRunTracker {
  readonly #runs = new Map<string, TrackedRun>();
  readonly #byChat = new Map<string, Set<string>>();
  readonly #active = new Map<string, string>();

  register(chatId: string, runId: string, publish: AgentRuntimePublisher): void {
    const existing = this.#runs.get(runId);
    if (existing && existing.chatId !== chatId) {
      throw new Error(`Run ${runId} is already routed for chat ${existing.chatId}`);
    }
    this.#runs.set(runId, { runId, chatId, publish });
    const owned = this.#byChat.get(chatId) ?? new Set<string>();
    owned.add(runId);
    this.#byChat.set(chatId, owned);
    this.#active.set(chatId, runId);
  }

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
        // A successor continues the operation its predecessor started, so it inherits that
        // route; the publisher passed in covers a successor that has no predecessor.
        const inherited = predecessor === null ? null : this.#runs.get(predecessor);
        this.register(chatId, successor, inherited?.publish ?? publish);
        downstream.commit();
      },
    };
  }

  current(chatId: string): string | null {
    return this.#active.get(chatId) ?? null;
  }

  // Resolves the run that produced an event from the provider's own name for it, and only from
  // that. An event the provider does not name cannot be attributed: routing it by what the chat
  // is doing now would publish one operation's content through another operation's capability,
  // which is the whole defect this routing exists to prevent. Unnamed events are the provider's
  // to fix at the point it drops the name, not this tracker's to guess at.
  correlate(chatId: string, metadata?: RuntimeEventMetadata): TrackedRun | null {
    const named = metadata?.turnId ?? metadata?.clientRequestId ?? null;
    if (!named) return null;
    const run = this.#runs.get(named);
    // A name is only meaningful within the chat that issued it; provider ids are not globally
    // unique, and a collision must not hand one chat's content to another chat's transcript.
    return run && run.chatId === chatId ? run : null;
  }

  finish(chatId: string, runId: string): void {
    // The run is no longer active, but its route stays: section 6 admits content a provider
    // flushes after the terminal, and its sink is still open to receive it.
    if (this.#active.get(chatId) === runId) this.#active.delete(chatId);
  }

  // Retires every route a chat's previous source owned. Called when a new session supersedes it,
  // which is the point the old source can no longer emit.
  release(chatId: string): void {
    for (const runId of this.#byChat.get(chatId) ?? []) this.#runs.delete(runId);
    this.#byChat.delete(chatId);
    this.#active.delete(chatId);
  }
}
