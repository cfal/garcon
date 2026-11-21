import type {
  CompletedAgentTurnReceipt, FailedAgentTurnReceipt, InterruptedAgentTurnReceipt,
} from './agent-turn-receipt.js';
import type { StartChatCommandRequest } from './chat-command-contracts.js';
import type { CommandOutcome } from './command-output.js';

export interface AutomationTurnKey {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly clientRequestId: string;
}

export type AutomationStartInput = Omit<StartChatCommandRequest,
  'chatId' | 'clientMessageId' | 'origin' | 'parentChatId' | 'executorId' | 'userMessagePresentation'
> & {
  readonly executorId: string;
  readonly title?: string;
  readonly providerRevision?: number | null;
};

export type ExecutionFailureCertainty = 'not-started' | 'definite' | 'unknown';

export type AutomationResult =
  | { readonly kind: 'completed'; readonly receipt: CompletedAgentTurnReceipt;
      readonly completeText: string | null; readonly commandOutcome: CommandOutcome | null }
  | { readonly kind: 'failed'; readonly certainty: ExecutionFailureCertainty;
      readonly receipt: FailedAgentTurnReceipt | null; readonly detail: string; readonly commandOutcome: CommandOutcome | null }
  | { readonly kind: 'interrupted'; readonly receipt: InterruptedAgentTurnReceipt; readonly termination: 'observed' | 'requested' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type AutomationStartResult =
  | { readonly kind: 'published' }
  | { readonly kind: 'not-started'; readonly code: string; readonly inputPublished: boolean }
  | { readonly kind: 'unknown'; readonly reason: string };

export type AutomationStopResult =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'stop-requested'; readonly delivery: 'unknown' }
  | { readonly kind: 'already-settled' }
  | { readonly kind: 'stale-target' }
  | { readonly kind: 'requires-explicit-chat-stop'; readonly chatId: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type AutomationSignalCandidate =
  | {
      readonly kind: 'emit';
      readonly name: string;
      readonly payload: {
        readonly contentType: 'none' | 'text' | 'json' | null;
        readonly text: string;
      };
    }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface AutomationSignal {
  readonly key: AutomationTurnKey;
  readonly source: { readonly transcriptViewId: string; readonly ordinal: number; readonly index: number };
  readonly candidate: AutomationSignalCandidate;
}

export type AutomationSignalDecision = void | { readonly kind: 'accepted' } | { readonly kind: 'rejected'; readonly message: string };
