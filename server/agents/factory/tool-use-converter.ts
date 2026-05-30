import {
  ApplyPatchToolUseMessage,
  BashToolUseMessage,
  EditToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ListToolUseMessage,
  ReadToolUseMessage,
  TaskToolUseMessage,
  TodoWriteToolUseMessage,
  UnknownToolUseMessage,
  WebFetchToolUseMessage,
  WebSearchToolUseMessage,
  WriteToolUseMessage,
} from '../../../common/chat-types.js';
import { normalizeTodoItems, normalizeToolInput } from '../shared/normalize-util.js';

type FactoryToolUseResult =
  | ApplyPatchToolUseMessage
  | BashToolUseMessage
  | EditToolUseMessage
  | GlobToolUseMessage
  | GrepToolUseMessage
  | ListToolUseMessage
  | ReadToolUseMessage
  | TaskToolUseMessage
  | TodoWriteToolUseMessage
  | UnknownToolUseMessage
  | WebFetchToolUseMessage
  | WebSearchToolUseMessage
  | WriteToolUseMessage;

interface FactoryToolUsePart {
  id?: string;
  input?: Record<string, unknown>;
  name?: string;
  parameters?: Record<string, unknown>;
  toolId?: string;
  toolName?: string;
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

function canonicalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function parseFactoryTodoString(raw: string): Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> | undefined {
  const items = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\.\s*/, ''))
    .map((line) => {
      const match = line.match(/^\[(pending|in_progress|completed)\]\s+(.+)$/);
      if (!match) return null;
      return {
        status: match[1] as 'pending' | 'in_progress' | 'completed',
        content: match[2].trim(),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return items.length > 0 ? items : undefined;
}

function normalizeFactoryTodos(input: Record<string, unknown>) {
  return normalizeTodoItems(input.todos ?? input.items)
    ?? (typeof input.todos === 'string' ? parseFactoryTodoString(input.todos) : undefined);
}

export function convertFactoryToolUse(ts: string, part: FactoryToolUsePart): FactoryToolUseResult {
  const rawName = typeof part.toolName === 'string'
    ? part.toolName
    : typeof part.name === 'string'
      ? part.name
      : typeof part.toolId === 'string'
        ? part.toolId
        : 'Unknown';
  const toolId = part.id || '';
  const input = asObject(part.parameters ?? part.input);
  const key = canonicalize(rawName);

  switch (key) {
    case 'execute':
    case 'bash':
    case 'executecli': {
      const command = asString(input.command ?? input.cmd);
      if (command === undefined) break;
      return new BashToolUseMessage(ts, toolId, command, asString(input.description));
    }

    case 'read': {
      const filePath = asString(input.file_path ?? input.filePath ?? input.path);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(
        ts,
        toolId,
        filePath,
        asNumber(input.offset ?? input.start_line ?? input.startLine),
        asNumber(input.limit ?? input.num_lines ?? input.numLines),
        asNumber(input.end_line ?? input.endLine),
      );
    }

    case 'ls':
    case 'listdirectory':
      return new ListToolUseMessage(ts, toolId, asString(input.path));

    case 'edit':
      return new EditToolUseMessage(
        ts,
        toolId,
        asString(input.file_path ?? input.filePath ?? input.path),
        asString(input.old_string ?? input.oldString ?? input.old_str),
        asString(input.new_string ?? input.newString ?? input.new_str),
        Array.isArray(input.changes) ? input.changes as Array<{ path?: string; kind?: string }> : undefined,
      );

    case 'applypatch':
      return new ApplyPatchToolUseMessage(
        ts,
        toolId,
        asString(input.file_path ?? input.filePath ?? input.path),
        asString(input.old_string ?? input.oldString ?? input.old_str),
        asString(input.new_string ?? input.newString ?? input.new_str),
      );

    case 'grep':
      return new GrepToolUseMessage(ts, toolId, asString(input.pattern), asString(input.path));

    case 'glob':
      return new GlobToolUseMessage(ts, toolId, asString(input.pattern), asString(input.path));

    case 'create': {
      const filePath = asString(input.file_path ?? input.filePath ?? input.path);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(ts, toolId, filePath, asString(input.content));
    }

    case 'websearch': {
      const query = asString(input.query);
      if (query === undefined) break;
      return new WebSearchToolUseMessage(ts, toolId, query);
    }

    case 'fetchurl':
    case 'webfetch': {
      const url = asString(input.url);
      if (url === undefined) break;
      return new WebFetchToolUseMessage(ts, toolId, url, asString(input.prompt ?? input.objective));
    }

    case 'todowrite':
      return new TodoWriteToolUseMessage(ts, toolId, normalizeFactoryTodos(input));

    case 'task':
      return new TaskToolUseMessage(
        ts,
        toolId,
        asString(input.subagent_type ?? input.subagentType),
        asString(input.description),
        asString(input.prompt),
        asString(input.model),
        asString(input.resume),
      );
  }

  return new UnknownToolUseMessage(ts, toolId, rawName, normalizeToolInput(part.parameters ?? part.input));
}
