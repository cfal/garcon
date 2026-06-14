// Discriminated union of all WebSocket messages the client can emit.
// Shared between server and frontend to enforce a typed contract.

import {
  isAmpAgentMode,
  isClaudeThinkingMode,
  isPermissionMode,
  isThinkingMode,
} from './chat-modes.js';
import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from './chat-modes.js';
import type { ApiProtocol } from './api-providers.js';

// Narrows an unknown value to string | null for chatId fields.
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// Narrows an unknown value to string | undefined for optional fields.
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// Narrows an unknown value to string | null | undefined, preserving omitted fields.
function strOrNullish(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === 'string' ? v : null;
}

// Parses a protocol kind field, returning null for invalid/missing values.
function parseProtocolOrNull(v: unknown): ApiProtocol | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v === 'openai-compatible' || v === 'anthropic-messages') return v;
  return null;
}

export interface ModelSelectionPayload {
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

function requireNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Invalid or missing ${field}`);
  }
  return v;
}

function requirePermissionMode(v: unknown): PermissionMode {
  const s = requireNonEmptyString(v, 'permissionMode');
  if (!isPermissionMode(s)) {
    throw new Error(`Invalid permissionMode: ${s}`);
  }
  return s;
}

function requireThinkingMode(v: unknown): ThinkingMode {
  const s = requireNonEmptyString(v, 'thinkingMode');
  if (!isThinkingMode(s)) {
    throw new Error(`Invalid thinkingMode: ${s}`);
  }
  return s;
}

function requireClaudeThinkingMode(v: unknown): ClaudeThinkingMode {
  const s = requireNonEmptyString(v, 'claudeThinkingMode');
  if (!isClaudeThinkingMode(s)) {
    throw new Error(`Invalid claudeThinkingMode: ${s}`);
  }
  return s;
}

function requireAmpAgentMode(v: unknown): AmpAgentMode {
  const s = requireNonEmptyString(v, 'ampAgentMode');
  if (!isAmpAgentMode(s)) {
    throw new Error(`Invalid ampAgentMode: ${s}`);
  }
  return s;
}

function parseAgentRunImages(v: unknown): AgentCommandImage[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v;
}

export interface AgentCommandImage {
  data: string;
  name: string;
}

export class AgentRunRequest {
  readonly type = 'agent-run' as const;
  constructor(
    public chatId: string,
    public command: string,
    public permissionMode: PermissionMode,
    public thinkingMode: ThinkingMode,
    public model: string,
    public claudeThinkingMode?: ClaudeThinkingMode,
    public ampAgentMode?: AmpAgentMode,
    public images?: AgentCommandImage[],
    public apiProviderId?: string | null,
    public modelEndpointId?: string | null,
    public modelProtocol?: ApiProtocol | null,
  ) { }

  static fromJson(data: Record<string, unknown>): AgentRunRequest {
    const chatId = requireNonEmptyString(data.chatId, 'chatId');
    const command = typeof data.command === 'string' ? data.command : '';
    const images = parseAgentRunImages(data.images);
    if (!command.trim() && (!images || images.length === 0)) {
      throw new Error('Invalid agent-run payload: command or images required');
    }

    return new AgentRunRequest(
      chatId,
      command,
      requirePermissionMode(data.permissionMode),
      requireThinkingMode(data.thinkingMode),
      requireNonEmptyString(data.model, 'model'),
      data.claudeThinkingMode === undefined ? undefined : requireClaudeThinkingMode(data.claudeThinkingMode),
      data.ampAgentMode === undefined ? undefined : requireAmpAgentMode(data.ampAgentMode),
      images,
      strOrNullish(data.apiProviderId),
      strOrNullish(data.modelEndpointId),
      parseProtocolOrNull(data.modelProtocol),
    );
  }
}

export class ForkRunRequest {
  readonly type = 'fork-run' as const;
  constructor(
    public sourceChatId: string,
    public chatId: string,
    public command: string,
    public permissionMode?: PermissionMode,
    public thinkingMode?: ThinkingMode,
    public model?: string,
    public claudeThinkingMode?: ClaudeThinkingMode,
    public ampAgentMode?: AmpAgentMode,
    public images?: AgentCommandImage[],
    public apiProviderId?: string | null,
    public modelEndpointId?: string | null,
    public modelProtocol?: ApiProtocol | null,
  ) { }

  static fromJson(data: Record<string, unknown>): ForkRunRequest {
    const sourceChatId = requireNonEmptyString(data.sourceChatId, 'sourceChatId');
    const chatId = requireNonEmptyString(data.chatId, 'chatId');
    const command = requireNonEmptyString(data.command, 'command');
    const images = parseAgentRunImages(data.images);

    return new ForkRunRequest(
      sourceChatId,
      chatId,
      command,
      data.permissionMode === undefined ? undefined : requirePermissionMode(data.permissionMode),
      data.thinkingMode === undefined ? undefined : requireThinkingMode(data.thinkingMode),
      strOrUndef(data.model),
      data.claudeThinkingMode === undefined ? undefined : requireClaudeThinkingMode(data.claudeThinkingMode),
      data.ampAgentMode === undefined ? undefined : requireAmpAgentMode(data.ampAgentMode),
      images,
      strOrNullish(data.apiProviderId),
      strOrNullish(data.modelEndpointId),
      parseProtocolOrNull(data.modelProtocol),
    );
  }
}

export class AgentStopRequest {
  readonly type = 'agent-stop' as const;
  constructor(public chatId: string | null, public agentId?: string) { }

  static fromJson(data: Record<string, unknown>): AgentStopRequest {
    return new AgentStopRequest(strOrNull(data.chatId), strOrUndef(data.agentId));
  }
}

export class ChatRunningQueryRequest {
  readonly type = 'chats-running-query' as const;
  static fromJson(): ChatRunningQueryRequest {
    return new ChatRunningQueryRequest();
  }
}

export class ChatLogQueryRequest {
  readonly type = 'chat-log-query' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
    public limit?: number,
    public beforeSeq?: number,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatLogQueryRequest {
    return new ChatLogQueryRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      data.limit as number | undefined,
      data.beforeSeq as number | undefined,
    );
  }
}

export class ChatSubscribeRequest {
  readonly type = 'chat-subscribe' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
    public logId: string,
    public afterAppendSeq: number,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatSubscribeRequest {
    const afterAppendSeq = typeof data.afterAppendSeq === 'number'
      && Number.isInteger(data.afterAppendSeq)
      && data.afterAppendSeq >= 0
      ? data.afterAppendSeq
      : 0;
    const logId = typeof data.logId === 'string' ? data.logId : '';
    return new ChatSubscribeRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      logId,
      afterAppendSeq,
    );
  }
}

export class ChatReloadRequest {
  readonly type = 'chat-reload' as const;
  constructor(
    public clientRequestId: string | null,
    public chatId: string | null,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatReloadRequest {
    return new ChatReloadRequest(strOrNull(data.clientRequestId), strOrNull(data.chatId));
  }
}

export class PermissionDecisionRequest {
  readonly type = 'permission-decision' as const;
  constructor(
    public chatId: string | null,
    public permissionRequestId: string | null,
    public allow: boolean,
    public alwaysAllow: boolean,
  ) { }

  static fromJson(data: Record<string, unknown>): PermissionDecisionRequest {
    return new PermissionDecisionRequest(
      strOrNull(data.chatId),
      strOrNull(data.permissionRequestId),
      Boolean(data.allow),
      Boolean(data.alwaysAllow),
    );
  }
}

export class PermissionModeSetRequest {
  readonly type = 'permission-mode-set' as const;
  constructor(public chatId: string | null, public mode?: PermissionMode) { }

  static fromJson(data: Record<string, unknown>): PermissionModeSetRequest {
    const mode = data.mode === undefined ? undefined : requirePermissionMode(data.mode);
    return new PermissionModeSetRequest(strOrNull(data.chatId), mode);
  }
}

export class ThinkingModeSetRequest {
  readonly type = 'thinking-mode-set' as const;
  constructor(public chatId: string | null, public mode?: ThinkingMode) { }

  static fromJson(data: Record<string, unknown>): ThinkingModeSetRequest {
    const mode = data.mode === undefined ? undefined : requireThinkingMode(data.mode);
    return new ThinkingModeSetRequest(strOrNull(data.chatId), mode);
  }
}

export class ClaudeThinkingModeSetRequest {
  readonly type = 'claude-thinking-mode-set' as const;
  constructor(public chatId: string | null, public mode?: ClaudeThinkingMode) { }

  static fromJson(data: Record<string, unknown>): ClaudeThinkingModeSetRequest {
    const mode = data.mode === undefined ? undefined : requireClaudeThinkingMode(data.mode);
    return new ClaudeThinkingModeSetRequest(strOrNull(data.chatId), mode);
  }
}

export class AmpAgentModeSetRequest {
  readonly type = 'amp-agent-mode-set' as const;
  constructor(public chatId: string | null, public mode?: AmpAgentMode) { }

  static fromJson(data: Record<string, unknown>): AmpAgentModeSetRequest {
    const mode = data.mode === undefined ? undefined : requireAmpAgentMode(data.mode);
    return new AmpAgentModeSetRequest(strOrNull(data.chatId), mode);
  }
}

export class ModelSetRequest {
  readonly type = 'model-set' as const;
  constructor(
    public chatId: string | null,
    public model?: string,
    public apiProviderId?: string | null,
    public modelEndpointId?: string | null,
    public modelProtocol?: ApiProtocol | null,
  ) { }

  static fromJson(data: Record<string, unknown>): ModelSetRequest {
    return new ModelSetRequest(
      strOrNull(data.chatId),
      strOrUndef(data.model),
      strOrNullish(data.apiProviderId),
      strOrNullish(data.modelEndpointId),
      parseProtocolOrNull(data.modelProtocol),
    );
  }
}

export class QueueEnqueueRequest {
  readonly type = 'queue-enqueue' as const;
  constructor(
    public chatId: string | null,
    public content: string,
    public agentId?: string,
    public projectName?: string,
    public projectPath?: string,
  ) { }

  static fromJson(data: Record<string, unknown>): QueueEnqueueRequest {
    return new QueueEnqueueRequest(
      strOrNull(data.chatId),
      typeof data.content === 'string' ? data.content : '',
      strOrUndef(data.agentId),
      strOrUndef(data.projectName),
      strOrUndef(data.projectPath),
    );
  }
}

export class QueueDropRequest {
  readonly type = 'dequeue-enqueue' as const;
  constructor(public chatId: string | null, public entryId?: string) { }

  static fromJson(data: Record<string, unknown>): QueueDropRequest {
    return new QueueDropRequest(strOrNull(data.chatId), strOrUndef(data.entryId));
  }
}

export class QueueClearRequest {
  readonly type = 'queue-clear' as const;
  constructor(public chatId: string | null) { }

  static fromJson(data: Record<string, unknown>): QueueClearRequest {
    return new QueueClearRequest(strOrNull(data.chatId));
  }
}

export class QueuePauseRequest {
  readonly type = 'queue-pause' as const;
  constructor(public chatId: string | null) { }

  static fromJson(data: Record<string, unknown>): QueuePauseRequest {
    return new QueuePauseRequest(strOrNull(data.chatId));
  }
}

export class QueueResumeRequest {
  readonly type = 'queue-resume' as const;
  constructor(public chatId: string | null) { }

  static fromJson(data: Record<string, unknown>): QueueResumeRequest {
    return new QueueResumeRequest(strOrNull(data.chatId));
  }
}

export class QueueQueryRequest {
  readonly type = 'queue-query' as const;
  constructor(public chatId: string | null) { }

  static fromJson(data: Record<string, unknown>): QueueQueryRequest {
    return new QueueQueryRequest(strOrNull(data.chatId));
  }
}

export type ClientWsMessage =
  | AgentRunRequest
  | ForkRunRequest
  | AgentStopRequest
  | ChatRunningQueryRequest
  | ChatLogQueryRequest
  | ChatSubscribeRequest
  | ChatReloadRequest
  | PermissionDecisionRequest
  | PermissionModeSetRequest
  | ThinkingModeSetRequest
  | ClaudeThinkingModeSetRequest
  | AmpAgentModeSetRequest
  | ModelSetRequest
  | QueueEnqueueRequest
  | QueueDropRequest
  | QueueClearRequest
  | QueuePauseRequest
  | QueueResumeRequest
  | QueueQueryRequest;

export function parseClientWsMessage(data: Record<string, unknown>): ClientWsMessage | null {
  switch (data.type) {
    case 'agent-run':
      return AgentRunRequest.fromJson(data);
    case 'fork-run':
      return ForkRunRequest.fromJson(data);
    case 'agent-stop':
      return AgentStopRequest.fromJson(data);
    case 'chats-running-query':
      return ChatRunningQueryRequest.fromJson();
    case 'chat-log-query':
      return ChatLogQueryRequest.fromJson(data);
    case 'chat-subscribe':
      return ChatSubscribeRequest.fromJson(data);
    case 'chat-reload':
      return ChatReloadRequest.fromJson(data);
    case 'permission-decision':
      return PermissionDecisionRequest.fromJson(data);
    case 'permission-mode-set':
      return PermissionModeSetRequest.fromJson(data);
    case 'thinking-mode-set':
      return ThinkingModeSetRequest.fromJson(data);
    case 'claude-thinking-mode-set':
      return ClaudeThinkingModeSetRequest.fromJson(data);
    case 'amp-agent-mode-set':
      return AmpAgentModeSetRequest.fromJson(data);
    case 'model-set':
      return ModelSetRequest.fromJson(data);
    case 'queue-enqueue':
      return QueueEnqueueRequest.fromJson(data);
    case 'dequeue-enqueue':
      return QueueDropRequest.fromJson(data);
    case 'queue-clear':
      return QueueClearRequest.fromJson(data);
    case 'queue-pause':
      return QueuePauseRequest.fromJson(data);
    case 'queue-resume':
      return QueueResumeRequest.fromJson(data);
    case 'queue-query':
      return QueueQueryRequest.fromJson(data);
    default:
      return null;
  }
}
