import type { AgentNativeTask } from '@garcon/server-agent-interface';
import type { NativeCleanupObserver } from '../execution/native-cleanup.js';
import { NativeQueryLifetime } from '../execution/native-query-lifetime.js';

/** Retains a Direct request and its response cleanup independently of caller cancellation. */
export class DirectNativeQuery implements NativeCleanupObserver {
  readonly #lifetime: NativeQueryLifetime;

  constructor(caller: AbortSignal, timeoutMs: number | undefined) {
    this.#lifetime = new NativeQueryLifetime(caller, timeoutMs, 'Direct query cancelled');
  }

  begin(run: (signal: AbortSignal, query: DirectNativeQuery) => Promise<string>): AgentNativeTask<string> {
    return this.#lifetime.begin((signal) => run(signal, this));
  }

  fetch(input: string, init: RequestInit): Promise<Response> {
    this.#lifetime.enter();
    return fetch(input, init).then((response) => {
      this.#lifetime.accepted();
      return response;
    });
  }

  failed(error: unknown): void { this.#lifetime.failed(error); }
}

export function fetchDirectQuery(query: DirectNativeQuery | null, input: string, init: RequestInit): Promise<Response> {
  return query ? query.fetch(input, init) : fetch(input, init);
}
