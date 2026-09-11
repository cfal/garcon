import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type {
  AgentEmissionSink,
  AgentExecutionAdmission,
  AgentNativeSessionRef,
  AgentGoalControlHandoff,
  AgentSteerResult,
} from '@garcon/server-agent-interface';
import type { ProviderConfigurationRequest } from './provider-configuration.js';

interface ProviderExecutionRequestBase {
  readonly chatId: string;
  readonly projectPath: string;
  readonly runId: string;
  readonly configuration: ProviderConfigurationRequest;
}

export type ProviderExecutionRequest = ProviderExecutionRequestBase & (
  | { readonly kind: 'start' }
  | {
      readonly kind: 'resume' | 'compact';
      readonly agentSessionId: string;
      readonly nativeSession: AgentNativeSessionRef | null;
    }
);

declare const providerExecutionOperation: unique symbol;

export interface ProviderExecutionOperation {
  readonly [providerExecutionOperation]: true;
}

declare const providerSteerTarget: unique symbol;

export interface ProviderSteerTarget {
  readonly [providerSteerTarget]: true;
}

export type ProviderSteerPreparation =
  | { readonly kind: 'ready'; readonly target: ProviderSteerTarget }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unsupported' };

export interface ProviderSteerInput {
  readonly input: string;
  readonly clientMessageId: string;
  readonly prepareDelivery: () => Promise<void>;
}

export interface ProviderGoalControlInput {
  readonly runId: string;
  readonly configuration: ProviderConfigurationRequest;
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
  readonly beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>;
}

export interface ProviderExecutionInput {
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
  readonly carriedContext: CarriedContext | null;
}

export interface ProviderExecutionDelivery {
  readonly output: AgentEmissionSink;
  readonly admission: AgentExecutionAdmission;
}

/** Server-local port; operations, output, and admission are capabilities, not wire payloads. */
export interface ProviderExecutionService {
  /** The signal covers preparation only; dispatch owns its execution admission. */
  prepare(request: ProviderExecutionRequest, signal: AbortSignal): Promise<ProviderExecutionOperation>;
  dispatch(operation: ProviderExecutionOperation, input: ProviderExecutionInput, delivery: ProviderExecutionDelivery): Promise<void>;
  /** Releases an unused preparation. Has no effect after dispatch. */
  release(operation: ProviderExecutionOperation): void;
  /** Requests cancellation of the exact operation; success is not proof of process termination. */
  abort(operation: ProviderExecutionOperation): Promise<boolean>;
  prepareSteer(operation: ProviderExecutionOperation, signal: AbortSignal): Promise<ProviderSteerPreparation>;
  steer(operation: ProviderExecutionOperation, target: ProviderSteerTarget, input: ProviderSteerInput): Promise<AgentSteerResult>;
  submitGoalControl(operation: ProviderExecutionOperation, input: ProviderGoalControlInput, signal: AbortSignal): Promise<boolean>;
}
