// Discriminated union of all chat message types. Shared between server
// and frontend -- the server converts provider-specific formats into
// these shapes, and the frontend renders them directly.

export interface ChatImage {
  data: string;
  name: string;
}

// Canonical shape for a single todo/plan item. All provider-specific
// formats are normalized to this at the converter boundary.
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

// Lightweight coercion for already-serialized TodoItem arrays.
// Provider-specific normalization lives in server/providers/normalize-util.
function asTodoItems(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const content = obj.content ?? obj.text ?? obj.step;
    if (typeof content !== 'string') continue;
    const s = obj.status;
    const completed = obj.completed;
    const status: TodoStatus =
      completed === true || s === 'completed' || s === 'done' ? 'completed' :
      s === 'in_progress' || s === 'in-progress' ? 'in_progress' : 'pending';
    items.push({ content, status });
  }
  return items.length > 0 ? items : undefined;
}

export class UserMessage {
  readonly type = 'user-message' as const;
  constructor(public timestamp: string, public content: string, public images?: ChatImage[]) {}
}

export class AssistantMessage {
  readonly type = 'assistant-message' as const;
  constructor(public timestamp: string, public content: string) {}
}

export class ThinkingMessage {
  readonly type = 'thinking' as const;
  constructor(public timestamp: string, public content: string) {}
}

export class BashToolUseMessage {
  readonly type = 'bash-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public command: string,
    public description?: string,
  ) {}
}

export class ReadToolUseMessage {
  readonly type = 'read-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath: string,
    public offset?: number,
    public limit?: number,
    public endLine?: number,
  ) {}
}

export class EditToolUseMessage {
  readonly type = 'edit-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath?: string,
    public oldString?: string,
    public newString?: string,
    public changes?: Array<{ path?: string; kind?: string }>,
  ) {}
}

export class WriteToolUseMessage {
  readonly type = 'write-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath: string,
    public content?: string,
  ) {}
}

export class ApplyPatchToolUseMessage {
  readonly type = 'apply-patch-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public filePath?: string,
    public oldString?: string,
    public newString?: string,
  ) {}
}

export class GrepToolUseMessage {
  readonly type = 'grep-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public pattern?: string,
    public path?: string,
  ) {}
}

export class GlobToolUseMessage {
  readonly type = 'glob-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public pattern?: string,
    public path?: string,
  ) {}
}

export class WebSearchToolUseMessage {
  readonly type = 'web-search-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public query: string,
  ) {}
}

export class WebFetchToolUseMessage {
  readonly type = 'web-fetch-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public url: string,
    public prompt?: string,
  ) {}
}

export class TodoWriteToolUseMessage {
  readonly type = 'todo-write-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public todos?: TodoItem[],
  ) {}
}

export class TodoReadToolUseMessage {
  readonly type = 'todo-read-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
  ) {}
}

export class TaskToolUseMessage {
  readonly type = 'task-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public subagentType?: string,
    public description?: string,
    public prompt?: string,
    public model?: string,
    public resume?: string,
  ) {}
}

export class UpdatePlanToolUseMessage {
  readonly type = 'update-plan-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public todos?: TodoItem[],
  ) {}
}

export class WriteStdinToolUseMessage {
  readonly type = 'write-stdin-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public input: Record<string, unknown>,
  ) {}
}

export class EnterPlanModeToolUseMessage {
  readonly type = 'enter-plan-mode-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
  ) {}
}

export class ExitPlanModeToolUseMessage {
  readonly type = 'exit-plan-mode-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public plan: string,
    public allowedPrompts?: Array<{ tool: string; prompt: string }>,
  ) {}
}

export class UnknownToolUseMessage {
  readonly type = 'unknown-tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public rawName: string,
    public input: Record<string, unknown>,
  ) {}
}

export class ToolResultMessage {
  readonly type = 'tool-result' as const;
  constructor(public timestamp: string, public toolId: string, public content: Record<string, unknown>, public isError: boolean) {}
}

export class ErrorMessage {
  readonly type = 'error' as const;
  constructor(public timestamp: string, public content: string) {}
}

export class PermissionRequestMessage {
  readonly type = 'permission-request' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public requestedTool: ToolUseChatMessage) {}
}

export class PermissionResolvedMessage {
  readonly type = 'permission-resolved' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public allowed: boolean) {}
}

export class PermissionCancelledMessage {
  readonly type = 'permission-cancelled' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public reason?: 'cancelled' | 'session-complete' | 'aborted') {}
}

// Union of all explicit tool-use message classes.
export type ToolUseChatMessage =
  | BashToolUseMessage
  | ReadToolUseMessage
  | EditToolUseMessage
  | WriteToolUseMessage
  | ApplyPatchToolUseMessage
  | GrepToolUseMessage
  | GlobToolUseMessage
  | WebSearchToolUseMessage
  | WebFetchToolUseMessage
  | TodoWriteToolUseMessage
  | TodoReadToolUseMessage
  | TaskToolUseMessage
  | UpdatePlanToolUseMessage
  | WriteStdinToolUseMessage
  | EnterPlanModeToolUseMessage
  | ExitPlanModeToolUseMessage
  | UnknownToolUseMessage;

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolUseChatMessage
  | ToolResultMessage
  | ErrorMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | PermissionCancelledMessage;

// Runtime guard for tool-use messages. Replaces the former base-class
// instanceof check.
export function isToolUseMessage(message: ChatMessage): message is ToolUseChatMessage {
  switch (message.type) {
    case 'bash-tool-use':
    case 'read-tool-use':
    case 'edit-tool-use':
    case 'write-tool-use':
    case 'apply-patch-tool-use':
    case 'grep-tool-use':
    case 'glob-tool-use':
    case 'web-search-tool-use':
    case 'web-fetch-tool-use':
    case 'todo-write-tool-use':
    case 'todo-read-tool-use':
    case 'task-tool-use':
    case 'update-plan-tool-use':
    case 'write-stdin-tool-use':
    case 'enter-plan-mode-tool-use':
    case 'exit-plan-mode-tool-use':
    case 'unknown-tool-use':
      return true;
    default:
      return false;
  }
}

// Narrows an unknown value to string, defaulting to ''.
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function asOptionalChanges(v: unknown): Array<{ path?: string; kind?: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v as Array<{ path?: string; kind?: string }>;
}

// Constructs a typed ChatMessage class instance from raw data.
// Returns null for unrecognized message types.
export function parseChatMessage(data: Record<string, unknown>): ChatMessage | null {
  switch (data.type) {
    case 'user-message':
      return new UserMessage(str(data.timestamp), str(data.content), data.images as ChatImage[] | undefined);
    case 'assistant-message':
      return new AssistantMessage(str(data.timestamp), str(data.content));
    case 'thinking':
      return new ThinkingMessage(str(data.timestamp), str(data.content));

    case 'bash-tool-use': {
      const command = asOptionalString(data.command);
      if (command === undefined) return null;
      return new BashToolUseMessage(
        str(data.timestamp), str(data.toolId),
        command, asOptionalString(data.description));
    }

    case 'read-tool-use': {
      const filePath = asOptionalString(data.filePath);
      if (filePath === undefined) return null;
      return new ReadToolUseMessage(
        str(data.timestamp), str(data.toolId),
        filePath,
        asOptionalNumber(data.offset), asOptionalNumber(data.limit),
        asOptionalNumber(data.endLine));
    }

    case 'edit-tool-use':
      return new EditToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asOptionalString(data.filePath),
        asOptionalString(data.oldString),
        asOptionalString(data.newString),
        asOptionalChanges(data.changes));

    case 'write-tool-use': {
      const filePath = asOptionalString(data.filePath);
      if (filePath === undefined) return null;
      return new WriteToolUseMessage(
        str(data.timestamp), str(data.toolId),
        filePath, asOptionalString(data.content));
    }

    case 'apply-patch-tool-use':
      return new ApplyPatchToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asOptionalString(data.filePath),
        asOptionalString(data.oldString),
        asOptionalString(data.newString));

    case 'grep-tool-use':
      return new GrepToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asOptionalString(data.pattern), asOptionalString(data.path));

    case 'glob-tool-use':
      return new GlobToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asOptionalString(data.pattern), asOptionalString(data.path));

    case 'web-search-tool-use': {
      const query = asOptionalString(data.query);
      if (query === undefined) return null;
      return new WebSearchToolUseMessage(
        str(data.timestamp), str(data.toolId), query);
    }

    case 'web-fetch-tool-use': {
      const url = asOptionalString(data.url);
      if (url === undefined) return null;
      return new WebFetchToolUseMessage(
        str(data.timestamp), str(data.toolId),
        url, asOptionalString(data.prompt));
    }

    case 'todo-write-tool-use':
      return new TodoWriteToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asTodoItems(data.todos));

    case 'todo-read-tool-use':
      return new TodoReadToolUseMessage(str(data.timestamp), str(data.toolId));

    case 'task-tool-use':
      return new TaskToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asOptionalString(data.subagentType),
        asOptionalString(data.description),
        asOptionalString(data.prompt),
        asOptionalString(data.model),
        asOptionalString(data.resume));

    case 'update-plan-tool-use':
      return new UpdatePlanToolUseMessage(
        str(data.timestamp), str(data.toolId),
        asTodoItems(data.todos));

    case 'write-stdin-tool-use':
      return new WriteStdinToolUseMessage(
        str(data.timestamp), str(data.toolId), asRecord(data.input));

    case 'enter-plan-mode-tool-use':
      return new EnterPlanModeToolUseMessage(str(data.timestamp), str(data.toolId));

    case 'exit-plan-mode-tool-use': {
      const plan = asOptionalString(data.plan);
      if (plan === undefined) return null;
      return new ExitPlanModeToolUseMessage(
        str(data.timestamp), str(data.toolId),
        plan,
        data.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined);
    }

    case 'unknown-tool-use':
      return new UnknownToolUseMessage(
        str(data.timestamp), str(data.toolId),
        str(data.rawName), asRecord(data.input));

    case 'tool-result':
      return new ToolResultMessage(str(data.timestamp), str(data.toolId), (data.content ?? {}) as Record<string, unknown>, Boolean(data.isError));
    case 'error':
      return new ErrorMessage(str(data.timestamp), str(data.content));
    case 'permission-request': {
      const requestedToolData = asRecord(data.requestedTool);
      const requestedTool = parseChatMessage(requestedToolData);
      if (!requestedTool || !isToolUseMessage(requestedTool)) return null;
      return new PermissionRequestMessage(str(data.timestamp), str(data.permissionRequestId), requestedTool);
    }
    case 'permission-resolved':
      return new PermissionResolvedMessage(str(data.timestamp), str(data.permissionRequestId), Boolean(data.allowed));
    case 'permission-cancelled':
      return new PermissionCancelledMessage(str(data.timestamp), str(data.permissionRequestId), data.reason as 'cancelled' | 'session-complete' | 'aborted' | undefined);
    default:
      return null;
  }
}

// Parses an array of raw message objects into typed ChatMessage instances.
// Silently drops entries with unrecognized types.
export function parseChatMessages(data: unknown): ChatMessage[] {
  if (!Array.isArray(data)) return [];
  const result: ChatMessage[] = [];
  for (const item of data) {
    const msg = parseChatMessage(item);
    if (msg) result.push(msg);
  }
  return result;
}
