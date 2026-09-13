import type { AgentDispatchOutcome } from './execution-lifetime.js';
import type { AgentSingleQueryRequest, AgentTextGenerationRequest } from './services.js';

export interface AgentNativeTask<T> {
  /** Reports entry certainty; every returned task requires settlement, including a pre-entry refusal. */
  readonly dispatch: Promise<AgentDispatchOutcome>;
  /** May reject on cancellation while native work remains occupied. */
  readonly result: Promise<T>;
  /** Fulfils only after native work and attributed IO and cleanup have drained. */
  readonly settled: Promise<void>;
  abort(): Promise<boolean>;
}

export interface AgentSingleQueryLifetime {
  /** Returns exact cleanup authority synchronously before provider-owned effects. */
  begin(request: AgentSingleQueryRequest): AgentNativeTask<string>;
}

export interface AgentTextGenerationLifetime {
  /** Preserves the tool-free text-generation contract with independently observed settlement. */
  begin(request: AgentTextGenerationRequest): AgentNativeTask<string>;
}
