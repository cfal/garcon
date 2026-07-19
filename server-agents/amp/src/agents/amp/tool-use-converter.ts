import {
  BashToolUseMessage,
  ReadToolUseMessage,
  EditToolUseMessage,
  WriteToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  WebSearchToolUseMessage,
  WebFetchToolUseMessage,
  AmpFinderToolUseMessage,
  AmpOracleToolUseMessage,
  AmpLibrarianToolUseMessage,
  AmpSkillToolUseMessage,
  AmpMermaidToolUseMessage,
  AmpHandoffToolUseMessage,
  AmpLookAtToolUseMessage,
  AmpFindThreadToolUseMessage,
  AmpReadThreadToolUseMessage,
  AmpTaskListToolUseMessage,
  UnknownToolUseMessage,
} from '@garcon/common/chat-types';

type AmpToolUseResult =
  | BashToolUseMessage
  | ReadToolUseMessage
  | EditToolUseMessage
  | WriteToolUseMessage
  | GlobToolUseMessage
  | GrepToolUseMessage
  | WebSearchToolUseMessage
  | WebFetchToolUseMessage
  | AmpFinderToolUseMessage
  | AmpOracleToolUseMessage
  | AmpLibrarianToolUseMessage
  | AmpSkillToolUseMessage
  | AmpMermaidToolUseMessage
  | AmpHandoffToolUseMessage
  | AmpLookAtToolUseMessage
  | AmpFindThreadToolUseMessage
  | AmpReadThreadToolUseMessage
  | AmpTaskListToolUseMessage
  | UnknownToolUseMessage;

interface AmpToolUsePart {
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asInput(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined || v === '') return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return { raw: v };
    } catch {
      return { raw: v };
    }
  }
  return {};
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function canonicalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const next = asString(value);
    if (next !== undefined) return next;
  }
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function inferWebSearchQuery(input: Record<string, unknown>): string | undefined {
  const objective = asString(input.objective);
  if (objective) return objective;
  if (Array.isArray(input.search_queries)) {
    const firstQuery = input.search_queries.find((value: unknown) => typeof value === 'string' && (value as string).trim());
    if (typeof firstQuery === 'string') return firstQuery;
  }
  return undefined;
}

export function convertAmpToolUse(ts: string, part: AmpToolUsePart): AmpToolUseResult {
  const rawName = typeof part?.name === 'string' ? part.name : 'Unknown';
  const toolId = part?.id || '';
  const input = asObject(part?.input);
  const key = canonicalize(rawName);

  switch (key) {
    case 'bash': {
      const command = firstString([input.cmd, input.command]);
      if (command === undefined) break;
      return new BashToolUseMessage(ts, toolId, command, asString(input.description));
    }

    case 'read': {
      const filePath = firstString([input.path, input.file_path, input.filePath]);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(ts, toolId, filePath);
    }

    case 'grep':
      return new GrepToolUseMessage(
        ts,
        toolId,
        asString(input.pattern),
        firstString([input.path, input.file_path, input.filePath]),
      );

    case 'glob': {
      const pattern = firstString([input.filePattern, input.pattern]);
      return new GlobToolUseMessage(
        ts,
        toolId,
        pattern,
        firstString([input.path, input.file_path, input.filePath]),
      );
    }

    case 'editfile':
      return new EditToolUseMessage(
        ts,
        toolId,
        firstString([input.path, input.file_path, input.filePath]),
        firstString([input.old_str, input.old_string, input.oldString]),
        firstString([input.new_str, input.new_string, input.newString]),
      );

    case 'createfile': {
      const filePath = firstString([input.path, input.file_path, input.filePath]);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(ts, toolId, filePath, asString(input.content));
    }

    case 'websearch': {
      const query = inferWebSearchQuery(input);
      if (query === undefined) break;
      return new WebSearchToolUseMessage(ts, toolId, query);
    }

    case 'readwebpage': {
      const url = asString(input.url);
      if (url === undefined) break;
      return new WebFetchToolUseMessage(ts, toolId, url, asString(input.objective));
    }

    case 'finder':
      return new AmpFinderToolUseMessage(
        ts,
        toolId,
        firstString([input.query, input.objective]),
      );

    case 'oracle':
      return new AmpOracleToolUseMessage(
        ts,
        toolId,
        asString(input.task),
        asString(input.context),
        asStringArray(input.files),
      );

    case 'librarian':
      return new AmpLibrarianToolUseMessage(
        ts,
        toolId,
        asString(input.query),
        asString(input.context),
      );

    case 'skill':
      return new AmpSkillToolUseMessage(
        ts,
        toolId,
        asString(input.name),
      );

    case 'mermaid':
      return new AmpMermaidToolUseMessage(ts, toolId);

    case 'handoff':
      return new AmpHandoffToolUseMessage(
        ts,
        toolId,
        asString(input.goal),
      );

    case 'lookat':
      return new AmpLookAtToolUseMessage(
        ts,
        toolId,
        asString(input.path),
        asString(input.objective),
      );

    case 'findthread':
      return new AmpFindThreadToolUseMessage(
        ts,
        toolId,
        asString(input.query),
      );

    case 'readthread':
      return new AmpReadThreadToolUseMessage(
        ts,
        toolId,
        firstString([input.threadID, input.threadId]),
        asString(input.goal),
      );

    case 'tasklist':
      return new AmpTaskListToolUseMessage(
        ts,
        toolId,
        asString(input.action),
        firstString([input.taskID, input.taskId]),
        asString(input.title),
        asString(input.status),
      );
  }

  return new UnknownToolUseMessage(ts, toolId, rawName, asInput(part?.input));
}
