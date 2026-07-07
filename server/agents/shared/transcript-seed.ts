// Renders a canonical ChatMessage transcript to plain seed text and strips that
// seed back off. A cross-agent switch cannot forge the target backend's native
// session, so the prior conversation is fed to the new agent as text: the
// universal ChatMessage[] hub is flattened here, the same renderer serving every
// agent (Claude -p, Codex startTurn, direct/* role+text).

import type { ChatMessage, ToolUseChatMessage } from '../../../common/chat-types.js';
import { UserMessage, isToolUseMessage } from '../../../common/chat-types.js';

// Delimiters wrapping the rendered prior conversation. Stable and explicit so
// the loader can reliably strip the seed from the new session's first turn.
export const SEED_CONTEXT_OPEN = '<carried-context>';
export const SEED_CONTEXT_CLOSE = '</carried-context>';

const DEFAULT_MAX_CHARS = 12_000;
const TRUNCATION_MARKER = '[earlier turns truncated]';
const TOOL_SUMMARY_MAX_CHARS = 200;

interface RenderTranscriptSeedOptions {
  maxChars?: number;
  fromAgentLabel?: string;
}

// Renders messages to a delimited seed string, keeping the MOST RECENT messages
// within maxChars. Returns '' when nothing is renderable.
export function renderTranscriptSeed(
  messages: ChatMessage[],
  options: RenderTranscriptSeedOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const lines: string[] = [];
  for (const message of messages) {
    const line = renderMessageLine(message);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return '';

  const preamble = `The following is a prior conversation with ${options.fromAgentLabel || 'another assistant'}. Continue it.`;
  const { kept, truncated } = capToMostRecent(lines, maxChars);
  const body = truncated ? [TRUNCATION_MARKER, ...kept] : kept;
  return [preamble, SEED_CONTEXT_OPEN, ...body, SEED_CONTEXT_CLOSE].join('\n');
}

// Removes a leading seed block (optional preamble + delimited context) from user
// text, returning the real user command. Leaves unrelated text unchanged.
export function stripTranscriptSeed(userText: string): string {
  const openIndex = userText.indexOf(SEED_CONTEXT_OPEN);
  if (openIndex === -1) return userText;

  // Only strip when the seed is at the start: anything before the open marker
  // must be the preamble line, not real user content.
  const prefix = userText.slice(0, openIndex);
  if (prefix.trim().length > 0 && !prefix.trimEnd().endsWith('Continue it.')) {
    return userText;
  }

  const closeIndex = userText.indexOf(SEED_CONTEXT_CLOSE, openIndex);
  if (closeIndex === -1) return userText;

  const remainder = userText.slice(closeIndex + SEED_CONTEXT_CLOSE.length);
  return remainder.replace(/^\s+/, '');
}

// Removes the carried-context seed from the first user message of a freshly
// loaded native transcript, so the new agent's session shows only the real turn.
// The prior conversation is displayed separately from the carry-over snapshot.
export function stripFirstUserSeed(messages: ChatMessage[]): ChatMessage[] {
  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return messages;
  const original = messages[index] as UserMessage;
  const stripped = stripTranscriptSeed(original.content);
  if (stripped === original.content) return messages;
  const clone = new UserMessage(original.timestamp, stripped, original.images, original.metadata);
  const next = messages.slice();
  next[index] = clone;
  return next;
}

// Keeps as many trailing lines as fit within maxChars (newline-joined length),
// signalling when older lines were dropped.
function capToMostRecent(lines: string[], maxChars: number): { kept: string[]; truncated: boolean } {
  if (maxChars <= 0) return { kept: lines, truncated: false };
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > maxChars && kept.length > 0) {
      return { kept, truncated: true };
    }
    kept.unshift(line);
    total += cost;
  }
  return { kept, truncated: false };
}

// Renders a single message to one line, or '' to drop it.
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
      // thinking, compaction, error, permission-* carry no seed signal.
      return '';
  }
}

// Canonical short tool label from the message type, e.g. 'bash-tool-use' -> 'bash'.
function toolName(message: ToolUseChatMessage): string {
  return message.type.replace(/-tool-use$/, '');
}

// A short human-readable summary of a tool call's most salient argument.
function toolSummary(message: ToolUseChatMessage): string {
  const raw = extractToolDetail(message);
  return truncate(collapse(raw), TOOL_SUMMARY_MAX_CHARS);
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
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
