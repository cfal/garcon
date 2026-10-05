import {
  BashToolUseMessage,
  EditToolUseMessage,
  ExecToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ListToolUseMessage,
  McpToolUseMessage,
  PiToolSearchToolUseMessage,
  ReadToolUseMessage,
  UnknownToolUseMessage,
  WriteToolUseMessage,
} from '@garcon/common/chat-types';
import { normalizeToolInput } from '@garcon/server-agent-common/shared/normalize-util';

type PiToolUseResult =
  | BashToolUseMessage
  | EditToolUseMessage
  | ExecToolUseMessage
  | GlobToolUseMessage
  | GrepToolUseMessage
  | ListToolUseMessage
  | McpToolUseMessage
  | PiToolSearchToolUseMessage
  | ReadToolUseMessage
  | UnknownToolUseMessage
  | WriteToolUseMessage;

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
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function parseEdits(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return parseEdits(parsed);
  } catch {
    return [];
  }
}

function firstEdit(input: Record<string, unknown>): { oldText?: string; newText?: string } {
  if (typeof input.oldText === 'string' || typeof input.newText === 'string') {
    return {
      oldText: asString(input.oldText),
      newText: asString(input.newText),
    };
  }
  const edits = parseEdits(input.edits);
  if (edits.length !== 1) return {};
  return {
    oldText: asString(edits[0].oldText),
    newText: asString(edits[0].newText),
  };
}

export function convertPiToolUse(
  timestamp: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
): PiToolUseResult {
  const input = asObject(args);
  const key = canonicalize(toolName || 'Unknown');
  const mcpPrefix = 'mcp__';
  if (toolName.startsWith(mcpPrefix)) {
    const encodedName = toolName.slice(mcpPrefix.length);
    const separator = encodedName.indexOf('__');
    const cappedHashedName = toolName.length === 64 && /_[0-9a-f]{8}$/.test(toolName);
    if (
      !cappedHashedName
      && separator > 0
      && separator === encodedName.lastIndexOf('__')
      && separator + 2 < encodedName.length
    ) {
      return new McpToolUseMessage(
        timestamp,
        toolCallId,
        encodedName.slice(0, separator),
        encodedName.slice(separator + 2),
        input,
      );
    }
    // Pi sanitization and the 64-character cap can make the server/tool boundary ambiguous or remove it.
    // https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/extensions/mcp/tools.ts#L83-L96
    return new McpToolUseMessage(timestamp, toolCallId, '', toolName, input);
  }

  switch (key) {
    case 'codemode':
      return new ExecToolUseMessage(timestamp, toolCallId, asString(input.code) ?? '', 'javascript');

    case 'powershell':
      return new ExecToolUseMessage(timestamp, toolCallId, asString(input.command) ?? '', 'powershell');

    case 'toolsearch':
      return new PiToolSearchToolUseMessage(
        timestamp,
        toolCallId,
        asString(input.query) ?? '',
        asNumber(input.limit),
      );

    case 'listmcpresources':
    case 'listmcpresourcetemplates':
    case 'readmcpresource':
      return new McpToolUseMessage(timestamp, toolCallId, asString(input.server) ?? '', toolName, input);

    case 'bash': {
      const command = asString(input.command);
      if (command === undefined) break;
      return new BashToolUseMessage(timestamp, toolCallId, command);
    }

    case 'read': {
      const filePath = asString(input.path);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(
        timestamp,
        toolCallId,
        filePath,
        asNumber(input.offset),
        asNumber(input.limit),
      );
    }

    case 'ls':
      return new ListToolUseMessage(timestamp, toolCallId, asString(input.path));

    case 'write': {
      const filePath = asString(input.path);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(timestamp, toolCallId, filePath, asString(input.content));
    }

    case 'edit': {
      const { oldText, newText } = firstEdit(input);
      return new EditToolUseMessage(timestamp, toolCallId, asString(input.path), oldText, newText);
    }

    case 'grep':
      return new GrepToolUseMessage(
        timestamp,
        toolCallId,
        asString(input.pattern),
        asString(input.path),
      );

    case 'find':
      return new GlobToolUseMessage(
        timestamp,
        toolCallId,
        asString(input.pattern),
        asString(input.path),
      );
  }

  return new UnknownToolUseMessage(
    timestamp,
    toolCallId,
    toolName || 'Unknown',
    normalizeToolInput(args),
  );
}
