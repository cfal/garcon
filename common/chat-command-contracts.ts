import {
  normalizePermissionMode,
  normalizeThinkingMode,
  isPermissionMode,
  isThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from './chat-modes.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from './agent-integration.js';
import type { JsonObject } from './json.js';
import type { AgentCommandImage } from './ws-requests.js';
import type { ApiProtocol } from './api-providers.js';
import type { ChatExecutionControlState } from './chat-execution-control.js';
import { parseChatTransientControlAction, type ChatTransientControlAction } from './chat-transient-feed.js';
import type { HttpErrorResponse } from './http-error.js';
import type { ChatListEntry } from './chat-list.js';
import type { ErrorCode } from './error-codes.js';
import { normalizeTags } from './tags.js';
import type { ChatStopOutcome } from './chat-types.js';
import {
  CommandRequestValidationError,
  optionalNonEmptyString,
  optionalNullableString,
  optionalRecord,
  optionalString,
  requestRecord,
  requiredChatId,
  requiredCommandCorrelationId,
  requiredContent,
  requiredQueueEntryId,
  requiredString,
} from './command-request-validation.js';

export {
  COMMAND_CORRELATION_ID_MAX_BYTES,
  QUEUE_ENTRY_ID_MAX_BYTES,
  CommandRequestValidationError,
  isCommandCorrelationIdWithinLimit,
  isQueueEntryIdWithinLimit,
} from './command-request-validation.js';

export type CommandStatus = 'accepted' | 'duplicate';

export type CommandErrorCode = Extract<
  ErrorCode,
  | 'VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CHAT_ID_COLLISION'
  | 'QUEUE_ENTRY_NOT_FOUND'
  | 'QUEUE_ENTRY_ALREADY_SENT'
  | 'QUEUE_ENTRY_IN_FLIGHT'
  | 'QUEUE_ENTRY_REVISION_CONFLICT'
  | 'QUEUE_ENTRY_REORDER_CONFLICT'
  | 'QUEUE_PAUSE_CHANGED'
  | 'STEER_NOT_DELIVERED'
  | 'STEER_OUTCOME_UNKNOWN'
  | 'STEER_PROVIDER_REJECTED'
  | 'STEER_TURN_UNAVAILABLE'
  | 'STEER_TURN_CHANGED'
  | 'STEER_TURN_NOT_STEERABLE'
  | 'STEER_CAPACITY_EXHAUSTED'
  | 'QUEUE_STEER_FINALIZATION_FAILED'
  | 'QUEUE_STEER_RECOVERY_FAILED'
  | 'GOAL_CONTROL_NOT_DELIVERED'
  | 'GOAL_CONTROL_OUTCOME_UNKNOWN'
  | 'UNSUPPORTED_AGENT'
  | 'EXPECTED_AGENT_MISMATCH'
  | 'EXPLICIT_BYPASS_REQUIRED'
  | 'INCOMPLETE_EXECUTION_CONFIG'
  | 'STALE_CHAT_OWNERSHIP'
  | 'OWNERSHIP_TRANSFER_PENDING'
  | 'AGENT_HANDOFF_REQUIRES_IDLE'
  | 'SOURCE_TRANSCRIPT_UNAVAILABLE'
  | 'CARRYOVER_HISTORY_UNAVAILABLE'
  | 'CONTEXT_ENVELOPE_MISMATCH'
  | 'CHAT_DELETED'
  | 'OPERATION_UNSUPPORTED'
  | 'SOURCE_REVISION_CHANGED'
  | 'TRANSCRIPT_UNAVAILABLE'
  | 'TRANSCRIPT_NOT_YET_PERSISTED'
  | 'MESSAGE_NOT_IN_NATIVE_HISTORY'
  | 'STALE_TRANSCRIPT_VIEW'
  | 'PROJECT_PATH_UPDATE_UNSUPPORTED'
  | 'CHAT_NOT_IDLE'
  | 'PROJECT_PATH_OUTSIDE_BASE'
  | 'PROJECT_PATH_NOT_FOUND'
  | 'PROJECT_PATH_NOT_DIRECTORY'
  | 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED'
  | 'SESSION_BUSY'
  | 'REQUEST_NOT_FOUND'
  | 'SERVER_SHUTTING_DOWN'
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

export interface AgentTurnCommandResponse extends CommandAcceptedResponse {
  chatId: string;
  turnId: string;
  chat?: ChatListEntry | null;
}

export interface StartChatCommandResponse extends AgentTurnCommandResponse {
  chat: ChatListEntry | null;
}

export interface ForkChatResponse {
  success: true;
  chat: ChatListEntry;
}

export interface ForkChatCommandRequest {
  sourceChatId: string;
  chatId: string;
  upToOrdinal?: number;
  transcriptViewId?: string;
}

export interface DeleteChatCommandRequest {
  chatId: string;
}

export interface ForkRunCommandResponse extends AgentTurnCommandResponse {
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
  transcriptViewId: string;
  excludedResendOrdinals?: number[];
  command: string;
  images?: AgentCommandImage[];
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettings?: AgentSettingsEnvelope;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  expectedAgentId?: string;
  tagsToAdd?: string[];
  permissionFallbackPolicy?: 'require-explicit-bypass';
  handoff?: AgentHandoffRequest;
}

export interface AgentHandoffTarget {
  agentId: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettings?: AgentSettingsEnvelope;
}

export interface AgentHandoffRequest {
  target: AgentHandoffTarget;
  expectedAgentOwnershipEpoch: string;
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
  clientMessageId: string;
  chatId: string;
  transcriptViewId: string;
  excludedResendOrdinals?: number[];
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

export type QueueEntryPlacement = 'before' | 'after';

export interface QueueEntryMoveCommandRequest {
  clientRequestId: string;
  chatId: string;
  entryId: string;
  targetEntryId: string;
  placement: QueueEntryPlacement;
  expectedReorderRevision: number;
  expectedSourceRevision: number;
  expectedTargetRevision: number;
}

export interface QueueEntryCommandResponse extends CommandAcceptedResponse {
  entryId: string;
  control: ChatExecutionControlState;
}

export interface QueueEntryDeleteResponse extends CommandAcceptedResponse {
  entryId: string;
  control: ChatExecutionControlState;
}

export interface SteerCommandRequest {
  clientRequestId: string;
  clientMessageId: string;
  chatId: string;
  transcriptViewId: string;
  content: string;
}

export interface SteerCommandResponse extends CommandAcceptedResponse {
  commandType: 'steer';
  chatId: string;
  turnId: string;
}

export interface QueueEntrySteerCommandRequest {
  clientRequestId: string;
  chatId: string;
  transcriptViewId: string;
  entryId: string;
  expectedRevision: number;
  expectedReorderRevision: number;
}

export interface QueueEntrySteerCommandResponse extends SteerCommandResponse {
  serverInstanceId: string;
  control?: ChatExecutionControlState;
}

export type SteerDeliveryOutcome = 'not-sent' | 'unknown' | 'accepted';

export interface QueueEntrySteerErrorResponse extends HttpErrorResponse {
  errorCode: CommandErrorCode;
  deliveryOutcome: SteerDeliveryOutcome;
  serverInstanceId: string;
  control?: ChatExecutionControlState;
}

export interface GoalControlCommandRequest {
  clientRequestId: string;
  clientMessageId: string;
  chatId: string;
  transcriptViewId: string;
  content: string;
}

export interface GoalControlCommandResponse extends CommandAcceptedResponse {
  commandType: 'goal-control';
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
  control: ChatTransientControlAction;
}

export interface AgentStopCommandRequest {
  clientRequestId: string;
  chatId: string;
  agentId?: string;
}

export interface AgentStopResponse extends CommandAcceptedResponse {
  outcome: ChatStopOutcome;
  control: ChatExecutionControlState;
}

export interface AgentInterruptAndSendCommandRequest {
  clientRequestId: string;
  chatId: string;
  agentId?: string;
}

export interface AgentInterruptAndSendResponse extends CommandAcceptedResponse {
  outcome: ChatStopOutcome;
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

export function parseStartChatCommandRequest(value: unknown): StartChatCommandRequest {
  const body = requestRecord(value);
  if ('options' in body) throw new CommandRequestValidationError('options is not supported');
  const clientRequestId = requiredCommandCorrelationId(body, 'clientRequestId');
  const clientMessageId = requiredCommandCorrelationId(body, 'clientMessageId');
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
  const handoff = optionalAgentHandoffRequest(body.handoff);
  const images = optionalImages(body.images);
  const model = optionalNonEmptyString(body, 'model');
  const apiProviderId = optionalNullableString(body, 'apiProviderId');
  const modelEndpointId = optionalNullableString(body, 'modelEndpointId');
  const modelProtocol = optionalApiProtocol(body.modelProtocol);
  if (model === undefined && (
    apiProviderId !== undefined
    || modelEndpointId !== undefined
    || modelProtocol !== undefined
  )) {
    throw new CommandRequestValidationError('model is required with routing overrides');
  }
  if (modelEndpointId !== undefined && apiProviderId === undefined) {
    throw new CommandRequestValidationError('apiProviderId is required with modelEndpointId');
  }
  const permissionMode = optionalPermissionMode(body.permissionMode);
  const thinkingMode = optionalThinkingMode(body.thinkingMode);
  const agentSettings = optionalAgentSettings(body.agentSettings, 'agentSettings');
  if (handoff && (
    model !== undefined
    || apiProviderId !== undefined
    || modelEndpointId !== undefined
    || modelProtocol !== undefined
    || permissionMode !== undefined
    || thinkingMode !== undefined
    || agentSettings !== undefined
  )) {
    throw new CommandRequestValidationError(
      'handoff cannot be combined with same-agent execution overrides',
    );
  }
  const expectedAgentId = optionalNonEmptyString(body, 'expectedAgentId');
  const permissionFallbackPolicy = body.permissionFallbackPolicy;
  if (
    permissionFallbackPolicy !== undefined
    && permissionFallbackPolicy !== null
    && permissionFallbackPolicy !== 'require-explicit-bypass'
  ) {
    throw new CommandRequestValidationError('permissionFallbackPolicy is invalid');
  }
  let tagsToAdd: string[] | undefined;
  if (body.tagsToAdd !== undefined && body.tagsToAdd !== null) {
    if (!Array.isArray(body.tagsToAdd)) {
      throw new CommandRequestValidationError('tagsToAdd must be an array');
    }
    tagsToAdd = normalizeTags(body.tagsToAdd);
  }
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    ...(optionalResendOrdinals(body.excludedResendOrdinals) ?? {}),
    command: contentOrImages(body, 'command', images),
    ...(images === undefined ? {} : { images }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(thinkingMode === undefined ? {} : { thinkingMode }),
    ...(agentSettings === undefined ? {} : { agentSettings }),
    ...(model === undefined ? {} : { model }),
    ...(apiProviderId === undefined ? {} : { apiProviderId }),
    ...(modelEndpointId === undefined ? {} : { modelEndpointId }),
    ...(modelProtocol === undefined ? {} : { modelProtocol }),
    ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
    ...(tagsToAdd === undefined ? {} : { tagsToAdd }),
    ...(permissionFallbackPolicy === 'require-explicit-bypass'
      ? { permissionFallbackPolicy }
      : {}),
    ...(handoff === undefined ? {} : { handoff }),
  };
}

function optionalAgentHandoffRequest(value: unknown): AgentHandoffRequest | undefined {
  if (value === undefined) return undefined;
  const handoff = requestRecord(value);
  const target = requestRecord(handoff.target);
  const agentId = requiredString(target, 'agentId');
  const model = requiredString(target, 'model');
  const apiProviderId = optionalNullableString(target, 'apiProviderId');
  const modelEndpointId = optionalNullableString(target, 'modelEndpointId');
  const modelProtocol = optionalApiProtocol(target.modelProtocol);
  if (modelEndpointId !== undefined && modelEndpointId !== null && apiProviderId == null) {
    throw new CommandRequestValidationError(
      'handoff.target.apiProviderId is required with modelEndpointId',
    );
  }
  const permissionMode = optionalPermissionMode(target.permissionMode);
  const thinkingMode = optionalThinkingMode(target.thinkingMode);
  const agentSettings = optionalAgentSettings(target.agentSettings, 'handoff.target.agentSettings');
  if (agentSettings && agentSettings.ownerId !== agentId) {
    throw new CommandRequestValidationError(
      'handoff.target.agentSettings must be owned by handoff.target.agentId',
    );
  }
  return {
    target: {
      agentId,
      model,
      ...(apiProviderId === undefined ? {} : { apiProviderId }),
      ...(modelEndpointId === undefined ? {} : { modelEndpointId }),
      ...(modelProtocol === undefined ? {} : { modelProtocol }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(thinkingMode === undefined ? {} : { thinkingMode }),
      ...(agentSettings === undefined ? {} : { agentSettings }),
    },
    expectedAgentOwnershipEpoch: requiredString(
      handoff,
      'expectedAgentOwnershipEpoch',
    ),
  };
}

export function parseForkRunCommandRequest(value: unknown): ForkRunCommandRequest {
  const body = requestRecord(value);
  const images = optionalImages(body.images);
  const agentSettings = optionalAgentSettings(body.agentSettings, 'agentSettings');
  const model = optionalString(body, 'model');
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
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
  const upToOrdinal = body.upToOrdinal;
  const transcriptViewId = optionalNonEmptyString(body, 'transcriptViewId');
  if (
    upToOrdinal !== undefined
    && (!Number.isSafeInteger(upToOrdinal) || Number(upToOrdinal) <= 0)
  ) {
    throw new CommandRequestValidationError('upToOrdinal must be a positive integer');
  }
  if (transcriptViewId !== undefined && upToOrdinal === undefined) {
    throw new CommandRequestValidationError('transcriptViewId requires upToOrdinal');
  }
  if (upToOrdinal !== undefined && transcriptViewId === undefined) {
    throw new CommandRequestValidationError('upToOrdinal requires transcriptViewId');
  }
  return {
    sourceChatId: requiredChatId(body, 'sourceChatId'),
    chatId: requiredChatId(body, 'chatId'),
    ...(upToOrdinal === undefined ? {} : { upToOrdinal: Number(upToOrdinal) }),
    ...(transcriptViewId === undefined ? {} : { transcriptViewId }),
  };
}

export function parseDeleteChatCommandRequest(value: unknown): DeleteChatCommandRequest {
  return { chatId: requiredChatId(requestRecord(value), 'chatId') };
}

export function parseQueueEntryCreateCommandRequest(value: unknown): QueueEntryCreateCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    ...(optionalResendOrdinals(body.excludedResendOrdinals) ?? {}),
    content: requiredContent(body, 'content'),
  };
}

function optionalResendOrdinals(value: unknown): { excludedResendOrdinals: number[] } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new CommandRequestValidationError('excludedResendOrdinals must be an array');
  }
  const ordinals = [...new Set(value.map((ordinal) => {
    if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 1) {
      throw new CommandRequestValidationError(
        'excludedResendOrdinals must contain positive integers',
      );
    }
    return Number(ordinal);
  }))].sort((left, right) => left - right);
  return ordinals.length > 0 ? { excludedResendOrdinals: ordinals } : undefined;
}

export function parseQueueEntryReplaceCommandRequest(value: unknown): QueueEntryReplaceCommandRequest {
  const body = requestRecord(value);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    throw new CommandRequestValidationError('expectedRevision must be a positive integer');
  }
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    entryId: requiredQueueEntryId(body, 'entryId'),
    content: requiredContent(body, 'content'),
    expectedRevision: Number(body.expectedRevision),
  };
}

export function parseQueueEntryDeleteCommandRequest(value: unknown): QueueEntryDeleteCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    entryId: requiredQueueEntryId(body, 'entryId'),
  };
}

export function parseQueueEntryMoveCommandRequest(value: unknown): QueueEntryMoveCommandRequest {
  const body = requestRecord(value);
  const entryId = requiredQueueEntryId(body, 'entryId');
  const targetEntryId = requiredQueueEntryId(body, 'targetEntryId');
  if (entryId === targetEntryId) {
    throw new CommandRequestValidationError('entryId and targetEntryId must differ');
  }
  if (body.placement !== 'before' && body.placement !== 'after') {
    throw new CommandRequestValidationError('placement must be before or after');
  }
  if (
    !Number.isSafeInteger(body.expectedReorderRevision)
    || Number(body.expectedReorderRevision) < 0
  ) {
    throw new CommandRequestValidationError(
      'expectedReorderRevision must be a non-negative integer',
    );
  }
  if (
    !Number.isSafeInteger(body.expectedSourceRevision)
    || Number(body.expectedSourceRevision) < 1
    || !Number.isSafeInteger(body.expectedTargetRevision)
    || Number(body.expectedTargetRevision) < 1
  ) {
    throw new CommandRequestValidationError(
      'expected source and target revisions must be positive integers',
    );
  }
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    entryId,
    targetEntryId,
    placement: body.placement,
    expectedReorderRevision: Number(body.expectedReorderRevision),
    expectedSourceRevision: Number(body.expectedSourceRevision),
    expectedTargetRevision: Number(body.expectedTargetRevision),
  };
}

export function parseSteerCommandRequest(value: unknown): SteerCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    content: requiredContent(body, 'content'),
  };
}

export function parseQueueEntrySteerCommandRequest(value: unknown): QueueEntrySteerCommandRequest {
  const body = requestRecord(value);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    throw new CommandRequestValidationError('expectedRevision must be a positive integer');
  }
  if (
    !Number.isSafeInteger(body.expectedReorderRevision)
    || Number(body.expectedReorderRevision) < 0
  ) {
    throw new CommandRequestValidationError(
      'expectedReorderRevision must be a non-negative integer',
    );
  }
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
    entryId: requiredQueueEntryId(body, 'entryId'),
    expectedRevision: Number(body.expectedRevision),
    expectedReorderRevision: Number(body.expectedReorderRevision),
  };
}

export function parseGoalControlCommandRequest(value: unknown): GoalControlCommandRequest {
  const body = requestRecord(value);
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    clientMessageId: requiredCommandCorrelationId(body, 'clientMessageId'),
    chatId: requiredChatId(body, 'chatId'),
    transcriptViewId: requiredString(body, 'transcriptViewId'),
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

export function parsePermissionDecisionCommandRequest(value: unknown): PermissionDecisionCommandRequest {
  const body = requestRecord(value);
  if (typeof body.allow !== 'boolean') throw new CommandRequestValidationError('allow must be a boolean');
  if (typeof body.alwaysAllow !== 'boolean') throw new CommandRequestValidationError('alwaysAllow must be a boolean');
  const response = optionalRecord(body.response, 'response');
  const control = parseChatTransientControlAction(body.control);
  if (!control) throw new CommandRequestValidationError('control is invalid');
  const chatId = requiredChatId(body, 'chatId');
  const permissionRequestId = requiredString(body, 'permissionRequestId');
  if (control.chatId !== chatId || control.id !== permissionRequestId) {
    throw new CommandRequestValidationError('control does not match the permission request');
  }
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    chatId,
    permissionRequestId,
    allow: body.allow,
    alwaysAllow: body.alwaysAllow,
    control,
    ...(response === undefined ? {} : { response }),
  };
}

export function parseAgentStopCommandRequest(value: unknown): AgentStopCommandRequest {
  const body = requestRecord(value);
  const agentId = optionalString(body, 'agentId');
  return {
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
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
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
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

function optionalPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPermissionMode(value)) {
    throw new CommandRequestValidationError('permissionMode is invalid');
  }
  return value;
}

function optionalThinkingMode(value: unknown): ThinkingMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isThinkingMode(value)) {
    throw new CommandRequestValidationError('thinkingMode is invalid');
  }
  return value;
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
