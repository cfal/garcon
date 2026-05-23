import {
  ApplyPatchToolUseMessage,
  BashToolUseMessage,
  EditToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ListToolUseMessage,
  ReadToolUseMessage,
  TaskToolUseMessage,
  TodoReadToolUseMessage,
  TodoWriteToolUseMessage,
  UnknownToolUseMessage,
  UpdatePlanToolUseMessage,
  WebFetchToolUseMessage,
  WebSearchToolUseMessage,
  WriteToolUseMessage,
} from '../../../common/chat-types.js';
import { normalizeTodoItems, normalizeToolInput } from '../shared/normalize-util.js';

type CursorToolUseResult =
  | ApplyPatchToolUseMessage
  | BashToolUseMessage
  | EditToolUseMessage
  | GlobToolUseMessage
  | GrepToolUseMessage
  | ListToolUseMessage
  | ReadToolUseMessage
  | TaskToolUseMessage
  | TodoReadToolUseMessage
  | TodoWriteToolUseMessage
  | UnknownToolUseMessage
  | UpdatePlanToolUseMessage
  | WebFetchToolUseMessage
  | WebSearchToolUseMessage
  | WriteToolUseMessage;

interface CursorToolEnvelope {
  id: string;
  input: unknown;
  rawName: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function canonicalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function displayNameFromWrapperKey(key: string): string {
  const base = key.replace(/ToolCall$/i, '');
  switch (canonicalize(base)) {
    case 'shell':
    case 'terminal':
    case 'execute':
    case 'runcommand':
      return 'Bash';
    case 'ls':
    case 'listdirectory':
      return 'LS';
    case 'searchfiles':
      return 'Grep';
    case 'fetchurl':
      return 'WebFetch';
    default:
      return base.charAt(0).toUpperCase() + base.slice(1);
  }
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractWrappedTool(raw: Record<string, unknown>): {
  input: unknown;
  rawName: string | null;
  tool: Record<string, unknown>;
} | null {
  const candidates = [raw.tool_call, raw.toolCall, raw.tool_call_delta, raw.toolCallDelta];
  for (const candidate of candidates) {
    const wrapper = asObject(candidate);
    const toolKey = Object.keys(wrapper).find((key) => key.toLowerCase().endsWith('toolcall'));
    if (!toolKey) continue;
    const tool = asObject(wrapper[toolKey]);
    return {
      tool,
      rawName: asString(tool.toolName ?? tool.name) ?? displayNameFromWrapperKey(toolKey),
      input: tool.args ?? tool.input ?? tool.parameters ?? tool,
    };
  }

  const topLevelToolKey = Object.keys(raw).find((key) => key.toLowerCase().endsWith('toolcall'));
  if (!topLevelToolKey) return null;
  const tool = asObject(raw[topLevelToolKey]);
  return {
    tool,
    rawName: asString(tool.toolName ?? tool.name) ?? displayNameFromWrapperKey(topLevelToolKey),
    input: tool.args ?? tool.input ?? tool.parameters ?? tool,
  };
}

function extractEnvelope(part: unknown): CursorToolEnvelope {
  const raw = asObject(part);
  const wrapped = extractWrappedTool(raw);
  const rawName = asString(raw.toolName ?? raw.name ?? raw.tool)
    ?? wrapped?.rawName
    ?? 'Unknown';
  const tool = wrapped?.tool ?? raw;
  const id = asString(raw.call_id ?? raw.callId ?? raw.toolCallId ?? raw.tool_call_id ?? raw.id)
    ?? asString(tool.call_id ?? tool.callId ?? tool.toolCallId ?? tool.tool_call_id ?? tool.id)
    ?? '';
  const input = wrapped?.input ?? raw.args ?? raw.input ?? raw.parameters ?? {};

  return { id, rawName, input: parseJsonString(input) };
}

function filePathFrom(input: Record<string, unknown>): string | undefined {
  return asString(input.file_path ?? input.filePath ?? input.path ?? input.file ?? input.filename);
}

function firstEdit(input: Record<string, unknown>): { oldText?: string; newText?: string } {
  const oldText = asString(input.old_string ?? input.oldString ?? input.old ?? input.search ?? input.original);
  const newText = asString(input.new_string ?? input.newString ?? input.new ?? input.replace ?? input.content);
  if (oldText !== undefined || newText !== undefined) return { oldText, newText };

  const edits = Array.isArray(input.edits) ? input.edits : [];
  if (edits.length !== 1) return {};
  const edit = asObject(edits[0]);
  return {
    oldText: asString(edit.old_string ?? edit.oldString ?? edit.oldText ?? edit.old),
    newText: asString(edit.new_string ?? edit.newString ?? edit.newText ?? edit.new),
  };
}

export function convertCursorToolUse(timestamp: string, part: unknown): CursorToolUseResult {
  const envelope = extractEnvelope(part);
  const input = asObject(envelope.input);
  const key = canonicalize(envelope.rawName);

  switch (key) {
    case 'bash':
    case 'shell':
    case 'terminal':
    case 'execute':
    case 'runcommand': {
      const command = asString(input.command ?? input.cmd ?? input.script);
      if (command === undefined) break;
      return new BashToolUseMessage(timestamp, envelope.id, command, asString(input.description));
    }

    case 'read': {
      const filePath = filePathFrom(input);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(
        timestamp,
        envelope.id,
        filePath,
        asNumber(input.offset ?? input.start_line ?? input.startLine),
        asNumber(input.limit ?? input.num_lines ?? input.numLines),
        asNumber(input.end_line ?? input.endLine),
      );
    }

    case 'ls':
    case 'list':
    case 'listdirectory':
    case 'readdir':
      return new ListToolUseMessage(timestamp, envelope.id, filePathFrom(input));

    case 'write':
    case 'create': {
      const filePath = filePathFrom(input);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(
        timestamp,
        envelope.id,
        filePath,
        asString(input.content ?? input.text ?? input.value ?? input.contents ?? input.fileContent ?? input.new_string ?? input.newString),
      );
    }

    case 'edit': {
      const { oldText, newText } = firstEdit(input);
      return new EditToolUseMessage(
        timestamp,
        envelope.id,
        filePathFrom(input),
        oldText,
        newText,
        Array.isArray(input.changes) ? input.changes as Array<{ path?: string; kind?: string }> : undefined,
      );
    }

    case 'applypatch':
    case 'patch':
      return new ApplyPatchToolUseMessage(
        timestamp,
        envelope.id,
        filePathFrom(input),
        asString(input.old_string ?? input.oldString ?? input.old),
        asString(input.new_string ?? input.newString ?? input.new),
        asString(input.patch ?? input.diff ?? input.content),
      );

    case 'grep':
    case 'search':
    case 'searchfiles':
      return new GrepToolUseMessage(
        timestamp,
        envelope.id,
        asString(input.pattern ?? input.query ?? input.search ?? input.regex),
        asString(input.path ?? input.cwd),
      );

    case 'glob':
    case 'find':
    case 'fileglob':
      return new GlobToolUseMessage(
        timestamp,
        envelope.id,
        asString(input.pattern ?? input.glob_pattern ?? input.globPattern ?? input.filePattern ?? input.glob ?? input.query),
        asString(input.path ?? input.cwd),
      );

    case 'websearch': {
      const query = asString(input.query);
      if (query === undefined) break;
      return new WebSearchToolUseMessage(timestamp, envelope.id, query);
    }

    case 'webfetch':
    case 'fetchurl':
    case 'fetch': {
      const url = asString(input.url);
      if (url === undefined) break;
      return new WebFetchToolUseMessage(timestamp, envelope.id, url, asString(input.prompt ?? input.objective));
    }

    case 'todowrite':
      return new TodoWriteToolUseMessage(timestamp, envelope.id, normalizeTodoItems(input.todos ?? input.items));

    case 'todoread':
      return new TodoReadToolUseMessage(timestamp, envelope.id);

    case 'updateplan':
      return new UpdatePlanToolUseMessage(timestamp, envelope.id, normalizeTodoItems(input.items ?? input.todos));

    case 'task':
      return new TaskToolUseMessage(
        timestamp,
        envelope.id,
        asString(input.subagent_type ?? input.subagentType),
        asString(input.description),
        asString(input.prompt),
        asString(input.model),
        asString(input.resume),
      );
  }

  return new UnknownToolUseMessage(timestamp, envelope.id, envelope.rawName, normalizeToolInput(envelope.input));
}
