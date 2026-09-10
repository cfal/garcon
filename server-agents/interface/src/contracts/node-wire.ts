import type { JsonObject } from '@garcon/common/json';
import type { NodeSessionIdentity } from '@garcon/common/node-operation';
import type { AgentPermissionResponseCapability, AgentProducerEvent, AgentProviderPermissionLifecycle } from './producer.js';

export interface NodePermissionHandleRegistrar {
  /** Creates an unregistered identifier without receiving response authority. */
  createHandle(): string;
  /**
   * Registers atomically after validation and rejects every previously registered handle, including retired handles.
   * Failure leaves existing bindings unchanged and retains no new capability; handles never rebind within a registry lifetime.
   */
  register(handle: string, decision: AgentPermissionResponseCapability, runId: string): void;
}

export interface ProducerStreamIdentity extends NodeSessionIdentity {
  readonly streamId: string;
}

export type WireProducerEvent =
  | { readonly type: 'rows'; readonly rows: readonly { readonly message: JsonObject; readonly providerMeta: JsonObject | null }[] }
  | Extract<AgentProducerEvent, { type: 'session' | 'notice' | 'run-ended' }>
  | {
      readonly type: 'permission';
      readonly runId: string;
      readonly lifecycle: Omit<Extract<AgentProviderPermissionLifecycle, { kind: 'requested' }>, 'requestedTool'>
        & { readonly requestedTool: JsonObject };
      readonly decisionHandle: string;
    }
  | {
      readonly type: 'permission';
      readonly runId: string;
      readonly lifecycle: Exclude<AgentProviderPermissionLifecycle, { kind: 'requested' }>;
      readonly decisionHandle?: never;
    };

export interface NodeOutputFrame {
  readonly type: 'node-output';
  readonly stream: ProducerStreamIdentity;
  readonly sequence: number;
  readonly event: WireProducerEvent;
}

export interface NodeOutputAck {
  readonly type: 'node-output-ack';
  readonly stream: ProducerStreamIdentity;
  readonly throughSequence: number;
}

export type NodeReplayReply =
  | { readonly type: 'node-replay-ready'; readonly stream: ProducerStreamIdentity;
      readonly afterSequence: number; readonly throughSequence: number }
  | { readonly type: 'node-replay-gap'; readonly stream: ProducerStreamIdentity;
      readonly requestedAfter: number; readonly firstRetainedSequence: number;
      readonly lastProducedSequence: number };
