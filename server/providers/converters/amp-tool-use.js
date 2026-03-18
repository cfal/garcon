import {
  BashToolUseMessage,
  ReadToolUseMessage,
  EditToolUseMessage,
  WriteToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  WebSearchToolUseMessage,
  WebFetchToolUseMessage,
  UnknownToolUseMessage,
} from '../../../common/chat-types.js';

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function asInput(v) {
  if (v === null || v === undefined || v === '') return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return { raw: v };
    } catch {
      return { raw: v };
    }
  }
  return {};
}

function asString(v) {
  return typeof v === 'string' ? v : undefined;
}

function canonicalize(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function firstString(values) {
  for (const value of values) {
    const next = asString(value);
    if (next !== undefined) return next;
  }
  return undefined;
}

function inferWebSearchQuery(input) {
  const objective = asString(input.objective);
  if (objective) return objective;
  if (Array.isArray(input.search_queries)) {
    const firstQuery = input.search_queries.find((value) => typeof value === 'string' && value.trim());
    if (typeof firstQuery === 'string') return firstQuery;
  }
  return undefined;
}

export function convertAmpToolUse(ts, part) {
  const rawName = typeof part?.name === 'string' ? part.name : 'Unknown';
  const toolId = part?.id || '';
  const input = asObject(part?.input);
  const key = canonicalize(rawName);

  switch (key) {
    case 'bash': {
      const command = firstString([input.cmd, input.command]);
      if (command === undefined) break;
      return new BashToolUseMessage(ts, toolId, rawName, command, asString(input.description));
    }

    case 'read': {
      const filePath = firstString([input.path, input.file_path, input.filePath]);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(ts, toolId, rawName, filePath);
    }

    case 'grep':
      return new GrepToolUseMessage(
        ts,
        toolId,
        rawName,
        asString(input.pattern),
        firstString([input.path, input.file_path, input.filePath]),
      );

    case 'glob': {
      const pattern = firstString([input.filePattern, input.pattern]);
      return new GlobToolUseMessage(
        ts,
        toolId,
        rawName,
        pattern,
        firstString([input.path, input.file_path, input.filePath]),
      );
    }

    case 'editfile':
      return new EditToolUseMessage(
        ts,
        toolId,
        rawName,
        firstString([input.path, input.file_path, input.filePath]),
        firstString([input.old_str, input.old_string, input.oldString]),
        firstString([input.new_str, input.new_string, input.newString]),
      );

    case 'createfile': {
      const filePath = firstString([input.path, input.file_path, input.filePath]);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(ts, toolId, rawName, filePath, asString(input.content));
    }

    case 'websearch': {
      const query = inferWebSearchQuery(input);
      if (query === undefined) break;
      return new WebSearchToolUseMessage(ts, toolId, rawName, query);
    }

    case 'readwebpage': {
      const url = asString(input.url);
      if (url === undefined) break;
      return new WebFetchToolUseMessage(ts, toolId, rawName, url, asString(input.objective));
    }
  }

  return new UnknownToolUseMessage(ts, toolId, rawName, asInput(part?.input));
}
