import type { AgentAttachment, AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentOwnershipEpoch } from '../ownership-epoch.js';
import type {
  AgentExecutionAdmission,
  AgentRunningSession,
  AgentProjectPathUpdatePreparation,
  AgentProjectPathUpdateRequest,
  AgentSessionConfiguration,
  AgentStartedSession,
} from './execution.js';
import type { AgentNativeSessionRef } from './transcript.js';

export type AgentOperationCommandTypeV4 =
  | 'chat-start'
  | 'agent-run'
  | 'fork-run'
  | 'agent-compact'
  | 'steer';

export interface AgentTurnReceiptOwner {
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly commandType: Exclude<AgentOperationCommandTypeV4, 'steer'>;
  readonly clientRequestId: string;
  readonly turnId: string;
}

export interface AgentOperationIdentityV4 {
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly commandType: AgentOperationCommandTypeV4;
  readonly clientRequestId: string | null;
  readonly clientMessageId: string | null;
  readonly turnId: string;
  readonly turnOwner: AgentTurnReceiptOwner | null;
}

export interface AgentTurnBoundOperationIdentityV4 extends AgentOperationIdentityV4 {
  readonly turnOwner: AgentTurnReceiptOwner;
}

export interface AgentTurnOwnerOperationIdentityV4
  extends AgentTurnBoundOperationIdentityV4 {
  readonly commandType: AgentTurnReceiptOwner['commandType'];
  readonly clientRequestId: string;
}

export interface AgentTranscriptAdmissionIdentity
  extends AgentTurnBoundOperationIdentityV4 {
  readonly commandType: Exclude<AgentOperationCommandTypeV4, 'agent-compact'>;
  readonly clientRequestId: string;
}

export interface AgentExecutionContextV4 {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
  readonly operation: AgentTurnOwnerOperationIdentityV4;
  readonly admission: AgentExecutionAdmission;
  readonly priorContext?: readonly ChatMessage[];
}

export interface AgentStartRequestV4 extends AgentExecutionContextV4 {
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
  readonly carriedContext: CarriedContext | null;
}

export interface AgentResumeRequestV4 extends AgentExecutionContextV4 {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
}

export interface AgentCompactRequestV4 extends AgentResumeRequestV4 {
  readonly prompt: string;
}

export interface AgentExecutionV4 {
  start(request: AgentStartRequestV4): Promise<AgentStartedSession>;
  resume(request: AgentResumeRequestV4): Promise<void>;
  abort(agentSessionId: string): Promise<boolean>;
  isRunning(agentSessionId: string): boolean;
  runningSessions(): readonly AgentRunningSession[];
  applySessionConfiguration?(
    agentSessionId: string,
    configuration: AgentSessionConfiguration,
  ): Promise<void>;
  respondToPermission?(
    permissionRequestId: string,
    decision: PermissionDecisionPayload,
  ): Promise<void>;
  prepareProjectPathUpdate?(
    request: AgentProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void>;
}
