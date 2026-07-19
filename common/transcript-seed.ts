import type { ChatMessage, ToolUseChatMessage } from './chat-types.js';
import { UserMessage, isToolUseMessage } from './chat-types.js';

export const SEED_CONTEXT_OPEN = '<carried-context>';
export const SEED_CONTEXT_CLOSE = '</carried-context>';

const DEFAULT_MAX_CHARS = 12_000;
const TRUNCATION_MARKER = '[earlier turns truncated]';
const TOOL_SUMMARY_MAX_CHARS = 200;

export function renderTranscriptSeed(
  messages: ChatMessage[],
  options: { maxChars?: number; fromAgentLabel?: string } = {},
): string {
  const lines = messages.map(renderMessageLine).filter(Boolean);
  if (lines.length === 0) return '';
  const preamble = `The following is a prior conversation with ${options.fromAgentLabel || 'another assistant'}. Continue it.`;
  const { kept, truncated } = capToMostRecent(
    lines,
    options.maxChars ?? DEFAULT_MAX_CHARS,
  );
  return [
    preamble,
    SEED_CONTEXT_OPEN,
    ...(truncated ? [TRUNCATION_MARKER, ...kept] : kept),
    SEED_CONTEXT_CLOSE,
  ].join('\n');
}

export function stripTranscriptSeed(userText: string): string {
  const openIndex = userText.indexOf(SEED_CONTEXT_OPEN);
  if (openIndex === -1) return userText;
  const prefix = userText.slice(0, openIndex);
  if (prefix.trim().length > 0 && !prefix.trimEnd().endsWith('Continue it.')) {
    return userText;
  }
  const closeIndex = userText.indexOf(SEED_CONTEXT_CLOSE, openIndex);
  if (closeIndex === -1) return userText;
  return userText.slice(closeIndex + SEED_CONTEXT_CLOSE.length).replace(/^\s+/, '');
}

export function stripFirstUserSeed(messages: ChatMessage[]): ChatMessage[] {
  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return messages;
  const original = messages[index] as UserMessage;
  const stripped = stripTranscriptSeed(original.content);
  if (stripped === original.content) return messages;
  const next = messages.slice();
  next[index] = new UserMessage(
    original.timestamp,
    stripped,
    original.images,
    original.metadata,
  );
  return next;
}

function capToMostRecent(
  lines: string[],
  maxChars: number,
): { kept: string[]; truncated: boolean } {
  if (maxChars <= 0) return { kept: lines, truncated: false };
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > maxChars && kept.length > 0) {
      return { kept, truncated: true };
    }
    kept.unshift(line);
    total += cost;
  }
  return { kept, truncated: false };
}

function renderMessageLine(message: ChatMessage): string {
  if (isToolUseMessage(message)) {
    return `Assistant used ${toolName(message)}: ${toolSummary(message)}`;
  }
  switch (message.type) {
    case 'user-message':
      return `User: ${collapse(message.content)}`;
    case 'assistant-message':
      return `Assistant: ${collapse(message.content)}`;
    case 'tool-result':
      return `Tool result: ${collapse(stringifyToolResult(message.content))}`;
    default:
      return '';
  }
}

function toolName(message: ToolUseChatMessage): string {
  return message.type.replace(/-tool-use$/, '');
}

function toolSummary(message: ToolUseChatMessage): string {
  return truncate(collapse(extractToolDetail(message)), TOOL_SUMMARY_MAX_CHARS);
}

function extractToolDetail(message: ToolUseChatMessage): string {
  switch (message.type) {
    case 'bash-tool-use':
      return message.description || message.command;
    case 'read-tool-use':
    case 'write-tool-use':
      return message.filePath;
    case 'edit-tool-use':
    case 'apply-patch-tool-use':
      return message.filePath ?? '';
    case 'list-tool-use':
      return message.path ?? '';
    case 'grep-tool-use':
    case 'glob-tool-use':
      return message.pattern ?? '';
    case 'web-search-tool-use':
      return message.query;
    case 'web-fetch-tool-use':
      return message.url;
    case 'task-tool-use':
      return message.description || message.prompt || message.subagentType || '';
    case 'external-tool-use':
      return message.name;
    case 'mcp-tool-use':
      return `${message.server}/${message.tool}`;
    case 'unknown-tool-use':
      return message.rawName;
    default:
      return '';
  }
}

function stringifyToolResult(content: Record<string, unknown>): string {
  const text = content.text ?? content.output ?? content.content ?? content.stdout;
  if (typeof text === 'string') return text;
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
