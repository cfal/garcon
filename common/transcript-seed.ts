import crypto from 'node:crypto';
import type { ChatMessage, ToolUseChatMessage } from './chat-types.js';
import { UserMessage, isToolUseMessage } from './chat-types.js';

export const SEED_CONTEXT_OPEN = '<carried-context>';
export const SEED_CONTEXT_CLOSE = '</carried-context>';
export const CARRIED_CONTEXT_VERSION = 1 as const;

const CARRIED_CONTEXT_OPEN_PREFIX = '<carried-context';
const CARRIED_CONTEXT_PREAMBLE =
  'Previous conversation context follows. Continue from it without repeating it.';

const DEFAULT_MAX_CHARS = 12_000;
const TRUNCATION_MARKER = '[earlier turns truncated]';
const TOOL_SUMMARY_MAX_CHARS = 200;

export interface NativeSeedReceipt {
  readonly headId: string;
  readonly agentSessionId: string;
  readonly placement: 'user-prefix' | 'provider-context';
  readonly format: 'v1-marker' | 'legacy-v0';
  readonly codeUnitLength: number;
  readonly sha256: string;
}

export type SanitizeCarriedContextResult =
  | { readonly kind: 'not-applicable'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'stripped-exact'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'absent'; readonly messages: readonly ChatMessage[] }
  | {
      readonly kind: 'mismatch';
      readonly messages: readonly ChatMessage[];
      readonly claimedHeadId: string | null;
      readonly reason: string;
    };

export function renderCarriedContextPrefix(
  headId: string,
  messages: readonly ChatMessage[],
  options: { maxChars?: number; fromAgentLabel?: string } = {},
): string {
  if (!isUuid(headId)) throw new Error('Carried-context head ID must be a UUID');
  const projection = renderTranscriptProjection([...messages], options)
    .replaceAll(SEED_CONTEXT_CLOSE, '&lt;/carried-context&gt;');
  return [
    `<carried-context version="${CARRIED_CONTEXT_VERSION}" id="${headId}">`,
    CARRIED_CONTEXT_PREAMBLE,
    '',
    projection,
    SEED_CONTEXT_CLOSE,
    '',
    '',
  ].join('\n');
}

export function createNativeSeedReceipt(input: {
  readonly headId: string;
  readonly agentSessionId: string;
  readonly placement: NativeSeedReceipt['placement'];
  readonly prefix: string;
  readonly format?: NativeSeedReceipt['format'];
}): NativeSeedReceipt {
  if (!isUuid(input.headId)) throw new Error('Native seed receipt head ID must be a UUID');
  if (!input.agentSessionId) throw new Error('Native seed receipt session ID is required');
  return {
    headId: input.headId,
    agentSessionId: input.agentSessionId,
    placement: input.placement,
    format: input.format ?? 'v1-marker',
    codeUnitLength: input.prefix.length,
    sha256: sha256(input.prefix),
  };
}

export function parseNativeSeedReceipt(value: unknown): NativeSeedReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (!isUuid(receipt.headId)) return null;
  if (typeof receipt.agentSessionId !== 'string' || !receipt.agentSessionId) return null;
  if (receipt.placement !== 'user-prefix' && receipt.placement !== 'provider-context') return null;
  if (receipt.format !== 'v1-marker' && receipt.format !== 'legacy-v0') return null;
  if (!Number.isSafeInteger(receipt.codeUnitLength) || Number(receipt.codeUnitLength) < 0) return null;
  if (typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null;
  return {
    headId: receipt.headId,
    agentSessionId: receipt.agentSessionId,
    placement: receipt.placement,
    format: receipt.format,
    codeUnitLength: Number(receipt.codeUnitLength),
    sha256: receipt.sha256,
  };
}

export function sanitizeRecordedCarriedContext(input: {
  readonly messages: readonly ChatMessage[];
  readonly receipt: NativeSeedReceipt | null;
  readonly agentSessionId: string | null;
}): SanitizeCarriedContextResult {
  const { messages, receipt } = input;
  if (!receipt) return { kind: 'not-applicable', messages };
  if (!input.agentSessionId || receipt.agentSessionId !== input.agentSessionId) {
    return mismatch(messages, null, 'Seed receipt does not name the current native session');
  }
  if (receipt.placement === 'provider-context') return { kind: 'not-applicable', messages };

  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return { kind: 'absent', messages };
  const original = messages[index] as UserMessage;
  if (!original.content.startsWith(CARRIED_CONTEXT_OPEN_PREFIX)) {
    return { kind: 'absent', messages };
  }

  const marker = parseAnchoredCarriedContextMarker(original.content);
  if (!marker) return mismatch(messages, null, 'Recorded carried-context marker is malformed');
  if (marker.headId !== receipt.headId) {
    return mismatch(messages, marker.headId, 'Recorded carried-context marker names another head');
  }
  const prefix = original.content.slice(0, receipt.codeUnitLength);
  if (prefix.length !== receipt.codeUnitLength || sha256(prefix) !== receipt.sha256) {
    return { kind: 'absent', messages };
  }

  const next = messages.slice();
  next[index] = new UserMessage(
    original.timestamp,
    original.content.slice(receipt.codeUnitLength),
    original.images,
    original.metadata,
  );
  return { kind: 'stripped-exact', messages: next };
}

export function renderTranscriptSeed(
  messages: ChatMessage[],
  options: { maxChars?: number; fromAgentLabel?: string } = {},
): string {
  const projection = renderTranscriptProjection(messages, options);
  if (!projection) return '';
  const [preamble, ...lines] = projection.split('\n');
  return [preamble, SEED_CONTEXT_OPEN, ...lines, SEED_CONTEXT_CLOSE].join('\n');
}

function renderTranscriptProjection(
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
    ...(truncated ? [TRUNCATION_MARKER, ...kept] : kept),
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

function parseAnchoredCarriedContextMarker(value: string): { headId: string } | null {
  const end = value.indexOf('\n');
  if (end === -1) return null;
  const match = /^<carried-context version="1" id="([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})">$/i
    .exec(value.slice(0, end));
  return match ? { headId: match[1].toLowerCase() } : null;
}

function mismatch(
  messages: readonly ChatMessage[],
  claimedHeadId: string | null,
  reason: string,
): SanitizeCarriedContextResult {
  return { kind: 'mismatch', messages, claimedHeadId, reason };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
