import type { PermissionMode, ThinkingMode } from './chat-modes.js';
import type { AgentSettingsEnvelope } from './agent-integration.js';
import type { JsonObject } from './json.js';
import type { AgentCommandImage } from './ws-requests.js';
import type { ApiProtocol } from './api-providers.js';
import type { ChatExecutionControlState } from './chat-execution-control.js';
import type { HttpErrorResponse } from './http-error.js';
import type { ChatListEntry } from './chat-list.js';

export type CommandStatus = 'accepted' | 'duplicate';

export type CommandErrorCode =
  | 'VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUEUE_ENTRY_NOT_FOUND'
  | 'QUEUE_ENTRY_ALREADY_SENT'
  | 'QUEUE_ENTRY_REVISION_CONFLICT'
  | 'QUEUE_PAUSE_CHANGED'
  | 'RECOVERED_INPUT_CONTINUATION_CHANGED'
  | 'RECOVERED_INPUT_CONTINUATION_REQUIRES_QUEUE'
  | 'ACTIVE_INPUT_NOT_DELIVERED'
  | 'ACTIVE_INPUT_OUTCOME_UNKNOWN'
  | 'UNSUPPORTED_AGENT'
  | 'PROJECT_PATH_UPDATE_UNSUPPORTED'
  | 'CHAT_NOT_IDLE'
  | 'PROJECT_PATH_OUTSIDE_BASE'
  | 'PROJECT_PATH_NOT_FOUND'
  | 'PROJECT_PATH_NOT_DIRECTORY'
  | 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED'
  | 'SESSION_BUSY'
  | 'REQUEST_NOT_FOUND'
  | 'SERVER_RESTART_INTERRUPTED'
  | 'INTERNAL_ERROR';

export interface CommandAcceptedResponse {
  success: true;
  commandType: string;
  clientRequestId: string;
  chatId?: string;
  turnId?: string;
  status: CommandStatus;
  acceptedAt: string;
}

export interface StartChatCommandResponse extends CommandAcceptedResponse {
  chat: ChatListEntry;
}

export interface ForkChatResponse {
  success: true;
  chat: ChatListEntry;
}

export interface ForkRunCommandResponse extends CommandAcceptedResponse {
  chat: ChatListEntry;
}

export interface CommandErrorResponse extends HttpErrorResponse {
  errorCode: CommandErrorCode;
}

export interface StartChatCommandRequest {
  clientRequestId: string;
  clientMessageId: string;
  chatId: string;
  agentId: string;
  projectPath: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
  command: string;
  images?: AgentCommandImage[];
  tags?: string[];
}

export interface AgentRunCommandRequest {
  clientRequestId: string;
  clientMessageId: string;
  chatId: string;
  command: string;
  images?: AgentCommandImage[];
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

export interface ForkRunCommandRequest {
  clientRequestId: string;
  clientMessageId: string;
  sourceChatId: string;
  chatId: string;
  command: string;
  images?: AgentCommandImage[];
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettings?: AgentSettingsEnvelope;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

export interface QueueEntryCreateCommandRequest {
  clientRequestId: string;
  chatId: string;
  content: string;
}

export interface QueueEntryReplaceCommandRequest {
  clientRequestId: string;
  chatId: string;
  entryId: string;
  content: string;
  expectedRevision: number;
}

export interface QueueEntryDeleteCommandRequest {
  clientRequestId: string;
  chatId: string;
  entryId: string;
}

export interface QueueEntryCommandResponse extends CommandAcceptedResponse {
  entryId: string;
  control: ChatExecutionControlState;
}

export interface QueueEntryDeleteResponse extends CommandAcceptedResponse {
  entryId: string;
  control: ChatExecutionControlState;
}

export interface ActiveInputCommandRequest {
  clientRequestId: string;
  chatId: string;
  content: string;
}

export interface ActiveInputCommandResponse extends CommandAcceptedResponse {
  delivery: 'active' | 'queued';
  entryId?: string;
  control: ChatExecutionControlState;
}

export interface QueueCommandErrorResponse extends HttpErrorResponse {
  control?: ChatExecutionControlState;
}

export interface QueueMutationRequest {
  chatId: string;
}

export type QueuePauseRequest = QueueMutationRequest;

export interface QueueResumeRequest extends QueueMutationRequest {
  pauseId: string;
}

export interface QueueMutationResponse {
  success: true;
  chatId: string;
  control: ChatExecutionControlState;
}

export interface RecoveredInputContinueRequest {
  chatId: string;
  continuationId: string;
}

export type RecoveredInputContinueResponse = QueueMutationResponse;

export interface AskUserQuestionAnswerPayload {
  questionId: string;
  selectedOptionIds: string[];
}

export interface AskUserQuestionAnsweredResponse extends Record<string, unknown> {
  type: 'ask-user-question-response';
  outcome: 'answered';
  answers: AskUserQuestionAnswerPayload[];
}

export interface AskUserQuestionSkippedResponse extends Record<string, unknown> {
  type: 'ask-user-question-response';
  outcome: 'skipped';
  reason?: string;
}

export type AskUserQuestionDecisionResponse = AskUserQuestionAnsweredResponse | AskUserQuestionSkippedResponse;

export interface PermissionDecisionPayload {
  allow: boolean;
  alwaysAllow?: boolean;
  response?: Record<string, unknown>;
}

export interface PermissionDecisionCommandRequest extends PermissionDecisionPayload {
  clientRequestId: string;
  chatId: string;
  permissionRequestId: string;
  alwaysAllow: boolean;
}

export interface AgentStopCommandRequest {
  clientRequestId: string;
  chatId: string;
  agentId?: string;
}

export interface AgentStopResponse extends CommandAcceptedResponse {
  stopped: boolean;
  control: ChatExecutionControlState;
}

export interface AgentInterruptAndSendCommandRequest {
  clientRequestId: string;
  chatId: string;
  agentId?: string;
}

export interface AgentInterruptAndSendResponse extends CommandAcceptedResponse {
  stopped: boolean;
  control: ChatExecutionControlState;
}

export interface CompactCommandRequest {
  clientRequestId: string;
  chatId: string;
  // Optional focus instructions for agents that support steering the summary.
  instructions?: string;
}

export interface ExecutionSettingsPatchRequest {
  chatId: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettingsPatch?: JsonObject;
}

export interface ExecutionSettingsPatchResponse {
  success: true;
  chatId: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
}

export interface ModelPatchRequest {
  chatId: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

export interface ModelPatchResponse {
  success: true;
  chatId: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

// Switches a chat to a different agent (or model within the same agent). A
// cross-agent switch starts a fresh native session seeded from the prior
// transcript, so the response echoes the modes normalized for the target agent.
export interface AgentModelPatchRequest {
  chatId: string;
  agentId: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

export interface AgentModelPatchResponse {
  success: true;
  chatId: string;
  agentId: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
}

export interface ProjectPathPatchRequest {
  chatId: string;
  projectPath: string;
}

export interface ProjectPathPatchResponse {
  success: true;
  chatId: string;
  projectPath: string;
  effectiveProjectKey: string;
  previousProjectPath: string;
  previousEffectiveProjectKey: string | null;
}

export interface RunningChatsResponse {
  sessions: Record<string, Array<{ id: string; [key: string]: unknown }>>;
}
