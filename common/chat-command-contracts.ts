import {
  normalizePermissionMode,
  normalizeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from './chat-modes.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from './agent-integration.js';
import type { JsonObject } from './json.js';
import type { AgentCommandImage } from './ws-requests.js';
import type { ApiProtocol } from './api-providers.js';
import type { ChatExecutionControlState } from './chat-execution-control.js';
import type { HttpErrorResponse } from './http-error.js';
import type { ChatListEntry } from './chat-list.js';
import type { ErrorCode } from './error-codes.js';
import { normalizeTags } from './tags.js';
import { InvalidChatIdError, parseChatId } from './chat-id.js';

export type CommandStatus = 'accepted' | 'duplicate';

export type CommandErrorCode = Extract<
  ErrorCode,
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
  | 'INTERNAL_ERROR'
>;

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

export interface ForkChatCommandRequest {
  sourceChatId: string;
  chatId: string;
  upToSeq?: number;
}

export interface DeleteChatCommandRequest {
  chatId: string;
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

export class CommandRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRequestValidationError';
  }
}

export function parseStartChatCommandRequest(value: unknown): StartChatCommandRequest {
  const body = requestRecord(value);
  if ('options' in body) throw new CommandRequestValidationError('options is not supported');
  const clientRequestId = requiredString(body, 'clientRequestId');
  const clientMessageId = requiredString(body, 'clientMessageId');
  const chatId = requiredChatId(body, 'chatId');
  const agentId = requiredString(body, 'agentId');
  const images = optionalImages(body.images);
  const command = contentOrImages(body, 'command', images).trim();
  const agentSettings = requiredAgentSettings(body.agentSettings, 'agentSettings');
  if (agentSettings.ownerId !== agentId) {
    throw new CommandRequestValidationError('agentSettings must be owned by agentId');
  }
  return {
    clientRequestId,
    clientMessageId,
    chatId,
    agentId,
    projectPath: requiredString(body, 'projectPath'),
    model: requiredString(body, 'model'),
    apiProviderId: optionalNullableString(body, 'apiProviderId'),
    modelEndpointId: optionalNullableString(body, 'modelEndpointId'),
    modelProtocol: optionalApiProtocol(body.modelProtocol),
    permissionMode: normalizePermissionMode(body.permissionMode),
    thinkingMode: normalizeThinkingMode(body.thinkingMode),
    agentSettings,
    command,
    ...(images === undefined ? {} : { images }),
    tags: normalizeTags(Array.isArray(body.tags) ? body.tags : []),
  };
}

export function parseAgentRunCommandRequest(value: unknown): AgentRunCommandRequest {
  const body = requestRecord(value);
  const images = optionalImages(body.images);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    clientMessageId: requiredString(body, 'clientMessageId'),
    chatId: requiredChatId(body, 'chatId'),
    command: contentOrImages(body, 'command', images),
    ...(images === undefined ? {} : { images }),
    permissionMode: normalizePermissionMode(body.permissionMode),
    thinkingMode: normalizeThinkingMode(body.thinkingMode),
    agentSettings: requiredAgentSettings(body.agentSettings, 'agentSettings'),
    model: requiredString(body, 'model'),
    apiProviderId: optionalNullableString(body, 'apiProviderId'),
    modelEndpointId: optionalNullableString(body, 'modelEndpointId'),
    modelProtocol: optionalApiProtocol(body.modelProtocol),
  };
}

export function parseForkRunCommandRequest(value: unknown): ForkRunCommandRequest {
  const body = requestRecord(value);
  const images = optionalImages(body.images);
  const agentSettings = optionalAgentSettings(body.agentSettings, 'agentSettings');
  const model = optionalString(body, 'model');
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    clientMessageId: requiredString(body, 'clientMessageId'),
    sourceChatId: requiredChatId(body, 'sourceChatId'),
    chatId: requiredChatId(body, 'chatId'),
    command: contentOrImages(body, 'command', images),
    ...(images === undefined ? {} : { images }),
    permissionMode: body.permissionMode === undefined
      ? undefined
      : normalizePermissionMode(body.permissionMode),
    thinkingMode: body.thinkingMode === undefined
      ? undefined
      : normalizeThinkingMode(body.thinkingMode),
    ...(agentSettings === undefined ? {} : { agentSettings }),
    ...(model === undefined ? {} : { model }),
    apiProviderId: optionalNullableString(body, 'apiProviderId'),
    modelEndpointId: optionalNullableString(body, 'modelEndpointId'),
    modelProtocol: optionalApiProtocol(body.modelProtocol),
  };
}

export function parseForkChatCommandRequest(value: unknown): ForkChatCommandRequest {
  const body = requestRecord(value);
  const upToSeq = body.upToSeq;
  if (upToSeq !== undefined && (!Number.isSafeInteger(upToSeq) || Number(upToSeq) <= 0)) {
    throw new CommandRequestValidationError('upToSeq must be a positive integer');
  }
  return {
    sourceChatId: requiredChatId(body, 'sourceChatId'),
    chatId: requiredChatId(body, 'chatId'),
    ...(upToSeq === undefined ? {} : { upToSeq: Number(upToSeq) }),
  };
}

export function parseDeleteChatCommandRequest(value: unknown): DeleteChatCommandRequest {
  return { chatId: requiredChatId(requestRecord(value), 'chatId') };
}

export function parseQueueEntryCreateCommandRequest(value: unknown): QueueEntryCreateCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    content: requiredContent(body, 'content'),
  };
}

export function parseQueueEntryReplaceCommandRequest(value: unknown): QueueEntryReplaceCommandRequest {
  const body = requestRecord(value);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    throw new CommandRequestValidationError('expectedRevision must be a positive integer');
  }
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    entryId: requiredString(body, 'entryId'),
    content: requiredContent(body, 'content'),
    expectedRevision: Number(body.expectedRevision),
  };
}

export function parseQueueEntryDeleteCommandRequest(value: unknown): QueueEntryDeleteCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    entryId: requiredString(body, 'entryId'),
  };
}

export function parseActiveInputCommandRequest(value: unknown): ActiveInputCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    content: requiredContent(body, 'content'),
  };
}

export function parseQueueMutationRequest(value: unknown): QueueMutationRequest {
  return { chatId: requiredChatId(requestRecord(value), 'chatId') };
}

export function parseQueueResumeRequest(value: unknown): QueueResumeRequest {
  const body = requestRecord(value);
  return {
    chatId: requiredChatId(body, 'chatId'),
    pauseId: requiredString(body, 'pauseId'),
  };
}

export function parseRecoveredInputContinueRequest(value: unknown): RecoveredInputContinueRequest {
  const body = requestRecord(value);
  return {
    chatId: requiredChatId(body, 'chatId'),
    continuationId: requiredString(body, 'continuationId'),
  };
}

export function parsePermissionDecisionCommandRequest(value: unknown): PermissionDecisionCommandRequest {
  const body = requestRecord(value);
  if (typeof body.allow !== 'boolean') {
    throw new CommandRequestValidationError('allow must be a boolean');
  }
  if (typeof body.alwaysAllow !== 'boolean') {
    throw new CommandRequestValidationError('alwaysAllow must be a boolean');
  }
  const response = optionalRecord(body.response, 'response');
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    permissionRequestId: requiredString(body, 'permissionRequestId'),
    allow: body.allow,
    alwaysAllow: body.alwaysAllow,
    ...(response === undefined ? {} : { response }),
  };
}

export function parseAgentStopCommandRequest(value: unknown): AgentStopCommandRequest {
  const body = requestRecord(value);
  const agentId = optionalString(body, 'agentId');
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    ...(agentId === undefined ? {} : { agentId }),
  };
}

export function parseAgentInterruptAndSendCommandRequest(value: unknown): AgentInterruptAndSendCommandRequest {
  return parseAgentStopCommandRequest(value);
}

export function parseCompactCommandRequest(value: unknown): CompactCommandRequest {
  const body = requestRecord(value);
  const instructions = optionalString(body, 'instructions', false);
  return {
    clientRequestId: requiredString(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    ...(instructions === undefined ? {} : { instructions }),
  };
}

export function parseProjectPathPatchRequest(value: unknown): ProjectPathPatchRequest {
  const body = requestRecord(value);
  return {
    chatId: requiredChatId(body, 'chatId'),
    projectPath: requiredString(body, 'projectPath'),
  };
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandRequestValidationError('request body must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandRequestValidationError(`${field} is required`);
  }
  return value.trim();
}

function requiredChatId(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  try {
    return parseChatId(value);
  } catch (error) {
    if (!(error instanceof InvalidChatIdError)) throw error;
    throw new CommandRequestValidationError(
      `${field} must be a valid 16-digit Unix-microsecond timestamp`,
    );
  }
}

function requiredContent(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandRequestValidationError(`${field} is required`);
  }
  return value;
}

function contentOrImages(
  body: Record<string, unknown>,
  field: string,
  images: AgentCommandImage[] | undefined,
): string {
  const value = typeof body[field] === 'string' ? body[field] : '';
  if (!value.trim() && (!images || images.length === 0)) {
    throw new CommandRequestValidationError(`${field} or images are required`);
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  trim = true,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CommandRequestValidationError(`${field} must be a string`);
  }
  return trim ? value.trim() : value;
}

function optionalNullableString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    throw new CommandRequestValidationError(`${field} must be a string or null`);
  }
  return value.trim();
}

function optionalApiProtocol(value: unknown): ApiProtocol | null | undefined {
  if (value === undefined || value === null) return value;
  if (value === 'anthropic-messages' || value === 'openai-compatible') return value;
  throw new CommandRequestValidationError('modelProtocol is invalid');
}

function requiredAgentSettings(value: unknown, field: string): AgentSettingsEnvelope {
  const parsed = parseAgentSettingsEnvelope(value);
  if (!parsed) throw new CommandRequestValidationError(`${field} is invalid`);
  return parsed;
}

function optionalAgentSettings(value: unknown, field: string): AgentSettingsEnvelope | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredAgentSettings(value, field);
}

function optionalImages(value: unknown): AgentCommandImage[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new CommandRequestValidationError('images must be an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CommandRequestValidationError('images must contain attachment objects');
    }
    const image = entry as Record<string, unknown>;
    if (typeof image.data !== 'string' || !image.data) {
      throw new CommandRequestValidationError('attachment data is required');
    }
    if (image.name !== undefined && typeof image.name !== 'string') {
      throw new CommandRequestValidationError('attachment name must be a string');
    }
    if (image.mimeType !== undefined && typeof image.mimeType !== 'string') {
      throw new CommandRequestValidationError('attachment mimeType must be a string');
    }
    return {
      data: image.data,
      ...(image.name === undefined ? {} : { name: image.name }),
      ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }),
    };
  });
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandRequestValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
