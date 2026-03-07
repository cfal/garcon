// Discriminated union of all WebSocket messages the client can emit.
// Shared between server and frontend to enforce a typed contract.

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default', 'acceptEdits', 'bypassPermissions', 'plan',
]);

// Narrows an unknown value to string | null for chatId fields.
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// Narrows an unknown value to string | undefined for optional fields.
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function requireNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Invalid or missing ${field}`);
  }
  return v;
}

function requirePermissionMode(v: unknown): PermissionMode {
  const s = requireNonEmptyString(v, 'permissionMode');
  if (!VALID_PERMISSION_MODES.has(s)) {
    throw new Error(`Invalid permissionMode: ${s}`);
  }
  return s as PermissionMode;
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
    public thinkingMode: string,
    public model: string,
    public images?: AgentCommandImage[],
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
      requireNonEmptyString(data.thinkingMode, 'thinkingMode'),
      requireNonEmptyString(data.model, 'model'),
      images,
    );
  }
}

export class AgentStopRequest {
  readonly type = 'agent-stop' as const;
  constructor(public chatId: string | null, public provider?: string) { }

  static fromJson(data: Record<string, unknown>): AgentStopRequest {
    return new AgentStopRequest(strOrNull(data.chatId), strOrUndef(data.provider));
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
    public offset?: number,
  ) { }

  static fromJson(data: Record<string, unknown>): ChatLogQueryRequest {
    return new ChatLogQueryRequest(
      strOrNull(data.clientRequestId),
      strOrNull(data.chatId),
      data.limit as number | undefined,
      data.offset as number | undefined,
    );
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
  constructor(public chatId: string | null, public mode?: string) { }

  static fromJson(data: Record<string, unknown>): PermissionModeSetRequest {
    return new PermissionModeSetRequest(strOrNull(data.chatId), strOrUndef(data.mode));
  }
}

export class ThinkingModeSetRequest {
  readonly type = 'thinking-mode-set' as const;
  constructor(public chatId: string | null, public mode?: string) { }

  static fromJson(data: Record<string, unknown>): ThinkingModeSetRequest {
    return new ThinkingModeSetRequest(strOrNull(data.chatId), strOrUndef(data.mode));
  }
}

export class ModelSetRequest {
  readonly type = 'model-set' as const;
  constructor(public chatId: string | null, public model?: string) { }

  static fromJson(data: Record<string, unknown>): ModelSetRequest {
    return new ModelSetRequest(strOrNull(data.chatId), strOrUndef(data.model));
  }
}

export class QueueEnqueueRequest {
  readonly type = 'queue-enqueue' as const;
  constructor(
    public chatId: string | null,
    public content: string,
    public provider?: string,
    public projectName?: string,
    public projectPath?: string,
  ) { }

  static fromJson(data: Record<string, unknown>): QueueEnqueueRequest {
    return new QueueEnqueueRequest(
      strOrNull(data.chatId),
      typeof data.content === 'string' ? data.content : '',
      strOrUndef(data.provider),
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
  | AgentStopRequest
  | ChatRunningQueryRequest
  | ChatLogQueryRequest
  | PermissionDecisionRequest
  | PermissionModeSetRequest
  | ThinkingModeSetRequest
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
    case 'agent-stop':
      return AgentStopRequest.fromJson(data);
    case 'chats-running-query':
      return ChatRunningQueryRequest.fromJson();
    case 'chat-log-query':
      return ChatLogQueryRequest.fromJson(data);
    case 'permission-decision':
      return PermissionDecisionRequest.fromJson(data);
    case 'permission-mode-set':
      return PermissionModeSetRequest.fromJson(data);
    case 'thinking-mode-set':
      return ThinkingModeSetRequest.fromJson(data);
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
