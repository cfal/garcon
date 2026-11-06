import type { CompletedAgentTurnReceipt, FailedAgentTurnReceipt, InterruptedAgentTurnReceipt } from './agent-turn-receipt.js';
import type { CommandOutcome } from './command-output.js';
import type { StartChatCommandRequest } from './chat-command-contracts.js';
import { isRecord } from './json.js';

export interface AutomationTurnKey {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly clientRequestId: string;
}
export interface ChatPresentation {
  readonly collection: 'conversation' | 'automation';
  readonly notifications: 'normal' | 'attention-only';
}
export interface ChatAutomationPolicy {
  readonly inBandCommands: 'inherit' | 'deny';
  readonly permissionDecisionAuthority: 'inherit' | 'browser-session';
}
export const CONVERSATION_PRESENTATION: ChatPresentation = Object.freeze({ collection: 'conversation', notifications: 'normal' });
export const INHERITED_AUTOMATION_POLICY: ChatAutomationPolicy = Object.freeze({ inBandCommands: 'inherit', permissionDecisionAuthority: 'inherit' });
export const AUTOMATION_PRESENTATION: ChatPresentation = Object.freeze({ collection: 'automation', notifications: 'attention-only' });
export const GUARDED_AUTOMATION_POLICY: ChatAutomationPolicy = Object.freeze({ inBandCommands: 'deny', permissionDecisionAuthority: 'browser-session' });

export function parseChatPresentation(value: unknown): ChatPresentation | null {
  if (!isRecord(value) || (value.collection !== 'conversation' && value.collection !== 'automation')
    || (value.notifications !== 'normal' && value.notifications !== 'attention-only')) return null;
  return { collection: value.collection, notifications: value.notifications };
}
export function parseChatAutomationPolicy(value: unknown): ChatAutomationPolicy | null {
  if (!isRecord(value) || (value.inBandCommands !== 'inherit' && value.inBandCommands !== 'deny')
    || (value.permissionDecisionAuthority !== 'inherit' && value.permissionDecisionAuthority !== 'browser-session')) return null;
  return { inBandCommands: value.inBandCommands, permissionDecisionAuthority: value.permissionDecisionAuthority };
}

export type ExecutionFailureCertainty = 'definite' | 'not-started' | 'unknown';
export interface AutomationExecutionScope {
  readonly executorId: string;
  readonly instanceId: string;
}
export interface AutomationTerminalEvidence {
  readonly executionScope: AutomationExecutionScope | null;
  readonly commandOutcome: CommandOutcome | null;
  readonly receivedOutputCoverage: 'complete' | 'gapped' | 'unknown';
}
export type AutomationResult = AutomationTerminalEvidence & (
  | { readonly kind: 'completed'; readonly receipt: CompletedAgentTurnReceipt }
  | { readonly kind: 'failed'; readonly certainty: ExecutionFailureCertainty; readonly receipt: FailedAgentTurnReceipt | null; readonly detail: string }
  | { readonly kind: 'interrupted'; readonly receipt: InterruptedAgentTurnReceipt | null; readonly termination: 'observed' | 'requested' }
  | { readonly kind: 'unavailable'; readonly reason: string }
);
export type AutomationStartResult =
  | { readonly kind: 'published' }
  | { readonly kind: 'not-started'; readonly code: string; readonly inputPublished: boolean }
  | { readonly kind: 'unknown'; readonly reason: string };
export type AutomationStopResult =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'stop-requested'; readonly delivery: 'confirmed' | 'unknown' }
  | { readonly kind: 'already-settled'; readonly result: AutomationResult }
  | { readonly kind: 'stale-target' }
  | { readonly kind: 'requires-explicit-chat-stop'; readonly chatId: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface EffectiveAutomationInput {
  readonly digest: string;
  readonly executorId: string;
  readonly projectPath: string;
  readonly promptDigest: string;
  readonly preambles: readonly { readonly id: string; readonly contentDigest: string }[];
  readonly selectionDigest: string;
  readonly providerRevision: number | null;
  readonly settingsDigest: string;
}

export type AutomationStartInput = Omit<StartChatCommandRequest,
  'chatId' | 'clientMessageId' | 'origin' | 'parentChatId' | 'images' | 'orderedPreambleIds'
> & {
  readonly title: string;
  readonly preambles: readonly { readonly id: string; readonly contentDigest: string }[];
  readonly providerRevision: number | null;
  readonly presentation: ChatPresentation;
  readonly automationPolicy: ChatAutomationPolicy;
};
