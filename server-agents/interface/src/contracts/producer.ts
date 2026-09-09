import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { ChatMessage, ToolUseChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type { NativeSeedReceipt } from '@garcon/common/transcript-seed';
import type { AgentNativeSessionRef } from './transcript.js';

export interface AgentProducedRow {
  readonly message: ChatMessage;
  readonly providerMeta?: JsonObject;
}

export interface AgentEstablishedSession {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly nativeSeedReceipt: NativeSeedReceipt | null;
}

export interface AgentPermissionOption extends JsonObject {
  readonly id: string;
  readonly label: string;
}

export type AgentPermissionLifecycle =
  | {
      readonly kind: 'requested';
      readonly permissionOccurrenceId: string;
      readonly requestedTool: ToolUseChatMessage;
      readonly options: readonly AgentPermissionOption[];
    }
  | {
      readonly kind: 'resolved';
      readonly permissionOccurrenceId: string;
      readonly decision: PermissionDecisionPayload;
    }
  | {
      readonly kind: 'cancelled';
      readonly permissionOccurrenceId: string;
      readonly reason: string | null;
    }
  | {
      readonly kind: 'expired';
      readonly permissionOccurrenceId: string;
    };

export type AgentProviderPermissionLifecycle = Exclude<
  AgentPermissionLifecycle,
  { readonly kind: 'resolved' }
>;

export interface AgentPermissionResponseCapability {
  readonly permissionOccurrenceId: string;
  respond(decision: PermissionDecisionPayload): Promise<void>;
}

type AgentPermissionRequestedEvent = {
  readonly type: 'permission';
  readonly runId: string;
  readonly lifecycle: Extract<AgentProviderPermissionLifecycle, { readonly kind: 'requested' }>;
  readonly decision: AgentPermissionResponseCapability;
};

type AgentPermissionTerminalEvent = {
  readonly type: 'permission';
  readonly runId: string;
  readonly lifecycle: Exclude<AgentProviderPermissionLifecycle, { readonly kind: 'requested' }>;
  readonly decision?: never;
};

export interface AgentRunFailureDetail {
  readonly code: string;
  readonly message?: string;
}

export interface AgentFinalResponse {
  readonly type: 'text';
  readonly text: string;
}

export type AgentRunEndedEvent =
  | {
      readonly type: 'run-ended';
      readonly runId: string;
      readonly outcome: 'finished';
      readonly finalResponse?: AgentFinalResponse;
      readonly error?: never;
    }
  | {
      readonly type: 'run-ended';
      readonly runId: string;
      readonly outcome: 'failed';
      readonly error?: AgentRunFailureDetail;
      readonly finalResponse?: never;
    }
  | {
      readonly type: 'run-ended';
      readonly runId: string;
      readonly outcome: 'interrupted';
      readonly error?: never;
      readonly finalResponse?: never;
    };

export type AgentProducerEvent =
  | { readonly type: 'rows'; readonly rows: readonly AgentProducedRow[] }
  | { readonly type: 'session'; readonly session: AgentEstablishedSession }
  | AgentPermissionRequestedEvent
  | AgentPermissionTerminalEvent
  // A durable presentation-only notice about the active run, such as a
  // provider-announced retry wait. It lands in the transcript as display-only
  // history and never reaches agent context, resend folds, or forks.
  | {
      readonly type: 'notice';
      readonly runId: string;
      readonly content: string;
      readonly title?: string;
    }
  | AgentRunEndedEvent;

export interface AgentProducerSink {
  // Returns only after synchronous controller ledger acceptance.
  publish(event: AgentProducerEvent): void;
}

export interface AgentEmissionSink {
  // Captures normalized output locally; remote emission does not imply ledger acceptance.
  emit(event: AgentProducerEvent): void;
}
