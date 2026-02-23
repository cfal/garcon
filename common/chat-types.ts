// Discriminated union of all chat message types. Shared between server
// and frontend -- the server converts provider-specific formats into
// these shapes, and the frontend renders them directly.

export interface ChatImage {
  data: string;
  name: string;
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

// Abstract base for all tool-use messages. Concrete subclasses carry
// typed domain-specific fields; UnknownToolUseMessage handles runtime
// tools not in the canonical set.
export abstract class ToolUseMessage {
  readonly type = 'tool-use' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public rawName: string,
  ) {}
}

export class BashToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public command: string,
    public description?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class ReadToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public filePath: string,
    public offset?: number,
    public limit?: number,
    public endLine?: number,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class EditToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public filePath?: string,
    public oldString?: string,
    public newString?: string,
    public changes?: Array<{ path?: string; kind?: string }>,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class WriteToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public filePath: string,
    public content?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class ApplyPatchToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public filePath?: string,
    public oldString?: string,
    public newString?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class GrepToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public pattern?: string,
    public path?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class GlobToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public pattern?: string,
    public path?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class WebSearchToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public query: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class WebFetchToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public url: string,
    public prompt?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class TodoWriteToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public todos?: unknown,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class TodoReadToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class TaskToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public subagentType?: string,
    public description?: string,
    public prompt?: string,
    public model?: string,
    public resume?: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class UpdatePlanToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public todos?: unknown,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class WriteStdinToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public input: Record<string, unknown>,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class EnterPlanModeToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class ExitPlanModeToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public plan: string,
    public allowedPrompts?: Array<{ tool: string; prompt: string }>,
  ) {
    super(timestamp, toolId, rawName);
  }
}

export class UnknownToolUseMessage extends ToolUseMessage {
  constructor(
    timestamp: string,
    toolId: string,
    rawName: string,
    public input: Record<string, unknown>,
  ) {
    super(timestamp, toolId, rawName);
  }
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
  constructor(public timestamp: string, public permissionRequestId: string, public toolName: string, public toolInput?: Record<string, unknown>) {}
}

export class PermissionResolvedMessage {
  readonly type = 'permission-resolved' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public allowed: boolean) {}
}

export class PermissionCancelledMessage {
  readonly type = 'permission-cancelled' as const;
  constructor(public timestamp: string, public permissionRequestId: string, public reason?: 'cancelled' | 'session-complete' | 'aborted') {}
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
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
  | UnknownToolUseMessage
  | ToolResultMessage
  | ErrorMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | PermissionCancelledMessage;

// Canonical tool names recognized by the typed factory.
type CanonicalToolName =
  | 'Bash' | 'Read' | 'Edit' | 'Write' | 'ApplyPatch'
  | 'Grep' | 'Glob' | 'WebSearch' | 'WebFetch'
  | 'TodoWrite' | 'TodoRead' | 'Task' | 'UpdatePlan'
  | 'WriteStdin' | 'EnterPlanMode' | 'ExitPlanMode';

// Maps lowercased, stripped names to canonical tool identifiers.
const TOOL_ALIASES: Record<string, CanonicalToolName> = {
  bash: 'Bash',
  shellcommand: 'Bash',
  execcommand: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  applypatch: 'ApplyPatch',
  grep: 'Grep',
  glob: 'Glob',
  websearch: 'WebSearch',
  webfetch: 'WebFetch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
  updateplan: 'UpdatePlan',
  writestdin: 'WriteStdin',
  enterplanmode: 'EnterPlanMode',
  planenter: 'EnterPlanMode',
  exitplanmode: 'ExitPlanMode',
  exitplan: 'ExitPlanMode',
  planexit: 'ExitPlanMode',
};

// Resolves a raw provider tool name to a canonical name. Returns null
// for names not matching any known alias.
export function normalizeToolName(raw: string): CanonicalToolName | null {
  const key = raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
  return TOOL_ALIASES[key] ?? null;
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

// Constructs a concrete ToolUseMessage subclass from a canonical name
// and a generic input record. Shared by the wire-format parser and
// the server-side factory.
function buildToolUseMessage(
  ts: string,
  id: string,
  rawName: string,
  canonical: CanonicalToolName | null,
  input: Record<string, unknown>,
): ToolUseMessage {
  switch (canonical) {
    case 'Bash': {
      const command = asOptionalString(input.command);
      if (command === undefined) break;
      return new BashToolUseMessage(ts, id, rawName, command,
        asOptionalString(input.description));
    }

    case 'Read': {
      const filePath = asOptionalString(input.file_path ?? input.filePath ?? input.path);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(ts, id, rawName, filePath,
        asOptionalNumber(input.offset ?? input.start_line ?? input.startLine),
        asOptionalNumber(input.limit ?? input.num_lines ?? input.numLines),
        asOptionalNumber(input.end_line ?? input.endLine));
    }

    case 'Edit':
      return new EditToolUseMessage(ts, id, rawName,
        asOptionalString(input.file_path ?? input.filePath),
        asOptionalString(input.old_string ?? input.oldString),
        asOptionalString(input.new_string ?? input.newString),
        asOptionalChanges(input.changes));

    case 'Write': {
      const filePath = asOptionalString(input.file_path ?? input.filePath);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(ts, id, rawName, filePath,
        asOptionalString(input.content));
    }

    case 'ApplyPatch':
      return new ApplyPatchToolUseMessage(ts, id, rawName,
        asOptionalString(input.file_path ?? input.filePath),
        asOptionalString(input.old_string ?? input.oldString),
        asOptionalString(input.new_string ?? input.newString));

    case 'Grep':
      return new GrepToolUseMessage(ts, id, rawName,
        asOptionalString(input.pattern),
        asOptionalString(input.path));

    case 'Glob':
      return new GlobToolUseMessage(ts, id, rawName,
        asOptionalString(input.pattern),
        asOptionalString(input.path));

    case 'WebSearch': {
      const query = asOptionalString(input.query);
      if (query === undefined) break;
      return new WebSearchToolUseMessage(ts, id, rawName, query);
    }

    case 'WebFetch': {
      const url = asOptionalString(input.url);
      if (url === undefined) break;
      return new WebFetchToolUseMessage(ts, id, rawName, url,
        asOptionalString(input.prompt));
    }

    case 'TodoWrite':
      return new TodoWriteToolUseMessage(ts, id, rawName,
        input.todos ?? input.items);

    case 'TodoRead':
      return new TodoReadToolUseMessage(ts, id, rawName);

    case 'Task':
      return new TaskToolUseMessage(ts, id, rawName,
        asOptionalString(input.subagent_type ?? input.subagentType),
        asOptionalString(input.description),
        asOptionalString(input.prompt),
        asOptionalString(input.model),
        asOptionalString(input.resume));

    case 'UpdatePlan':
      return new UpdatePlanToolUseMessage(ts, id, rawName,
        input.items ?? input.todos);

    case 'WriteStdin':
      return new WriteStdinToolUseMessage(ts, id, rawName, input);

    case 'EnterPlanMode':
      return new EnterPlanModeToolUseMessage(ts, id, rawName);

    case 'ExitPlanMode': {
      const plan = asOptionalString(input.plan);
      if (plan === undefined) break;
      return new ExitPlanModeToolUseMessage(ts, id, rawName, plan,
        input.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined);
    }
  }

  // Fallback: unrecognized canonical name, or known name with
  // malformed/missing required fields. Extract the nested `input`
  // record (from serialized UnknownToolUseMessage) if present.
  const unknownInput = input.input !== undefined
    ? asRecord(input.input)
    : input;
  return new UnknownToolUseMessage(ts, id, rawName, unknownInput);
}

// Message envelope keys that must not leak into domain input records.
const MESSAGE_META_KEYS = new Set(['type', 'timestamp', 'toolId', 'rawName', 'toolName', 'toolInput']);

// Strips envelope metadata from a data object, returning only
// domain-relevant fields for use as tool input.
function stripMeta(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (!MESSAGE_META_KEYS.has(key)) result[key] = data[key];
  }
  return result;
}

// Parses a tool-use message from wire-format data. Handles two
// distinct formats with explicit branches:
// - Legacy: toolName + toolInput record (from provider events)
// - Typed:  rawName + subclass fields directly on the object
function parseToolUseMessage(data: Record<string, unknown>): ToolUseMessage {
  const ts = str(data.timestamp);
  const toolId = str(data.toolId);
  const rawName = str(data.rawName ?? data.toolName);
  const canonical = normalizeToolName(rawName);

  // Legacy wire format: toolInput is an explicit record of domain fields.
  if (data.toolInput !== undefined) {
    return buildToolUseMessage(ts, toolId, rawName, canonical, asRecord(data.toolInput));
  }

  // Typed serialization: domain fields live directly on the data object
  // alongside envelope metadata. Strip metadata before dispatching.
  return buildToolUseMessage(ts, toolId, rawName, canonical, stripMeta(data));
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
    case 'tool-use':
      return parseToolUseMessage(data);
    case 'tool-result':
      return new ToolResultMessage(str(data.timestamp), str(data.toolId), (data.content ?? {}) as Record<string, unknown>, Boolean(data.isError));
    case 'error':
      return new ErrorMessage(str(data.timestamp), str(data.content));
    case 'permission-request':
      return new PermissionRequestMessage(str(data.timestamp), str(data.permissionRequestId), str(data.toolName), data.toolInput as Record<string, unknown> | undefined);
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
