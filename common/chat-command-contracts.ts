import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from './chat-modes.js';
import type { AgentCommandImage } from './ws-requests.js';
import type { ApiProtocol } from './api-providers.js';
import type { QueueState } from './queue-state.js';
import type { HttpErrorResponse } from './http-error.js';

export type CommandStatus = 'accepted' | 'duplicate' | 'already-applied';

export type CommandErrorCode =
  | 'VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_AGENT'
  | 'PROJECT_PATH_UPDATE_UNSUPPORTED'
  | 'CHAT_NOT_IDLE'
  | 'PROJECT_PATH_OUTSIDE_BASE'
  | 'PROJECT_PATH_NOT_FOUND'
  | 'PROJECT_PATH_NOT_DIRECTORY'
  | 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED'
  | 'SESSION_BUSY'
  | 'REQUEST_NOT_FOUND'
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
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
  command: string;
  options?: Record<string, unknown> & { images?: AgentCommandImage[] };
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
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
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
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

export interface QueueEnqueueCommandRequest {
  clientRequestId: string;
  chatId: string;
  content: string;
}

export interface QueueEnqueueResponse extends CommandAcceptedResponse {
  entryId: string;
  merged: boolean;
  queue: QueueState;
}

export interface QueueMutationRequest {
  chatId: string;
  entryId?: string;
}

export interface QueueMutationResponse {
  success: true;
  chatId: string;
  queue: QueueState;
}

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

export type AskUserQuestionDecisionResponse =
  | AskUserQuestionAnsweredResponse
  | AskUserQuestionSkippedResponse;

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
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
}

export interface ExecutionSettingsPatchResponse {
  success: true;
  chatId: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
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

export interface ProjectPathPatchRequest {
  chatId: string;
  projectPath: string;
}

export interface ProjectPathPatchResponse {
  success: true;
  chatId: string;
  projectPath: string;
  previousProjectPath: string;
  nativePath: string | null;
}

export interface RunningChatsResponse {
  sessions: Record<string, Array<{ id: string; [key: string]: unknown }>>;
}
