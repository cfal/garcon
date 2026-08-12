import type { AgentAttachment } from '@garcon/common/agent-execution';
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
      readonly requestId: string;
      readonly incarnation: string;
      readonly requestedTool: ToolUseChatMessage;
      readonly options: readonly AgentPermissionOption[];
    }
  | {
      readonly kind: 'resolved';
      readonly requestId: string;
      readonly incarnation: string;
      readonly decision: PermissionDecisionPayload;
    }
  | {
      readonly kind: 'cancelled';
      readonly requestId: string;
      readonly incarnation: string;
      readonly reason: string | null;
    }
  | {
      readonly kind: 'expired';
      readonly requestId: string;
      readonly incarnation: string;
    };

export type AgentProviderPermissionLifecycle = Exclude<
  AgentPermissionLifecycle,
  { readonly kind: 'resolved' }
>;

export interface AgentRunFailureDetail {
  readonly code: string;
  readonly message?: string;
}

export type AgentProducerEvent =
  | { readonly type: 'rows'; readonly rows: readonly AgentProducedRow[] }
  | { readonly type: 'session'; readonly session: AgentEstablishedSession }
  | {
      readonly type: 'permission';
      readonly runId: string;
      readonly lifecycle: AgentProviderPermissionLifecycle;
    }
  | {
      readonly type: 'run-ended';
      readonly runId: string;
      readonly outcome: 'finished' | 'failed' | 'interrupted';
      readonly error?: AgentRunFailureDetail;
    };

export interface AgentProducerSink {
  publish(event: AgentProducerEvent): void;
}

export interface AgentOutboundPrompt {
  readonly content: string;
  readonly attachments: readonly AgentAttachment[];
}
