import type { AgentResumeRequestV5, AgentStartRequestV5 } from './execution-v5.js';

export type AgentExecutionLifetimeRequest =
  | { readonly kind: 'start'; readonly request: AgentStartRequestV5 }
  | { readonly kind: 'resume' | 'compact'; readonly request: AgentResumeRequestV5 };

export type AgentDispatchOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'unknown'; readonly error: unknown };

export interface AgentExecutionAttempt {
  /** Reports dispatch certainty; only a proven refusal before native entry is rejected. */
  readonly dispatch: Promise<AgentDispatchOutcome>;
  /**
   * Fulfils after observed native quiescence and drainage of attributed IO and cleanup.
   * Rejection leaves settlement unconfirmed. Terminals, abort acknowledgements and timeouts are not proof.
   */
  readonly settled: Promise<void>;
  /** Retains exact cancellation even when no session or execution handle was returned. */
  abort(): Promise<boolean>;
}

export interface AgentExecutionLifetime {
  /** Returns cleanup authority synchronously before any provider-owned effect can begin. */
  begin(request: AgentExecutionLifetimeRequest): AgentExecutionAttempt;
}
