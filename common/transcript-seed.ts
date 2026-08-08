import crypto from 'node:crypto';
import type { ChatMessage, ToolUseChatMessage } from './chat-types.js';
import { UserMessage, isToolUseMessage } from './chat-types.js';

export const SEED_CONTEXT_OPEN = '<carried-context>';
export const SEED_CONTEXT_CLOSE = '</carried-context>';
export const CARRIED_CONTEXT_VERSION = 2 as const;

const CARRIED_CONTEXT_OPEN_PREFIX = '<carried-context';
const CARRIED_CONTEXT_PREAMBLE =
  'Previous conversation context follows. Continue from it without repeating it.';
const DEFAULT_MAX_CHARS = 12_000;
const TOOL_SUMMARY_MAX_CHARS = 200;
const MESSAGE_PROJECTION_MAX_CHARS = 4_000;
const TRUNCATION_ELEMENT = '    <earlier-turns-truncated/>';

export interface NativeSeedReceipt {
  readonly agentSessionId: string;
  readonly placement: 'user-prefix' | 'provider-context';
  readonly format: 'v2-xml' | 'v1-marker' | 'legacy-v0';
  readonly codeUnitLength: number;
  readonly sha256: string;
}

export interface CarriedContext {
  readonly prefix: string;
}

export type SanitizeCarriedContextResult =
  | { readonly kind: 'not-applicable'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'stripped-exact'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'absent'; readonly messages: readonly ChatMessage[] }
  | {
      readonly kind: 'mismatch';
      readonly messages: readonly ChatMessage[];
      readonly reason: string;
    };

export function renderCarriedContext(
  messages: readonly ChatMessage[],
  options: { readonly maxChars?: number } = {},
): CarriedContext | null {
  const projected = messages.filter(isProjectableMessage);
  if (projected.length === 0) return null;

  const opening = [
    `<carried-context version="${CARRIED_CONTEXT_VERSION}">`,
    `  <instructions>${CARRIED_CONTEXT_PREAMBLE}</instructions>`,
    '  <transcript>',
  ].join('\n');
  const closing = '  </transcript>\n</carried-context>\n\n';
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const unlimited = maxChars <= 0;
  const fullElements = projected.map((message) => renderMessageElement(message));
  const full = `${opening}\n${fullElements.join('\n')}\n${closing}`;
  if (unlimited || full.length <= maxChars) return { prefix: full };

  const truncatedMinimum = `${opening}\n${TRUNCATION_ELEMENT}\n${closing}`;
  if (truncatedMinimum.length > maxChars) {
    throw new RangeError(`Carried-context budget must be at least ${truncatedMinimum.length} characters`);
  }

  const available = Math.max(0, maxChars - opening.length - closing.length - 2);
  const selected: string[] = [];
  let used = TRUNCATION_ELEMENT.length;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const separator = 1;
    const element = fullElements[index];
    if (used + separator + element.length <= available) {
      selected.unshift(element);
      used += separator + element.length;
      continue;
    }
    if (selected.length === 0) {
      const remaining = available - used - separator;
      const fitted = renderMessageElement(projected[index], remaining);
      if (fitted) selected.unshift(fitted);
    }
    break;
  }
  return {
    prefix: `${opening}\n${[TRUNCATION_ELEMENT, ...selected].join('\n')}\n${closing}`,
  };
}

export function createNativeSeedReceipt(input: {
  readonly agentSessionId: string;
  readonly placement: NativeSeedReceipt['placement'];
  readonly prefix: string;
  readonly format?: NativeSeedReceipt['format'];
}): NativeSeedReceipt {
  if (!input.agentSessionId) throw new Error('Native seed receipt session ID is required');
  return {
    agentSessionId: input.agentSessionId,
    placement: input.placement,
    format: input.format ?? 'v2-xml',
    codeUnitLength: input.prefix.length,
    sha256: sha256(input.prefix),
  };
}

export function receiptForCarriedContext(
  carriedContext: CarriedContext | null,
  agentSessionId: string,
  placement: NativeSeedReceipt['placement'] = 'user-prefix',
): NativeSeedReceipt | null {
  return carriedContext
    ? createNativeSeedReceipt({
        agentSessionId,
        placement,
        prefix: carriedContext.prefix,
      })
    : null;
}

export function retargetNativeSeedReceipt(
  receipt: NativeSeedReceipt | null,
  agentSessionId: string,
): NativeSeedReceipt | null {
  if (!receipt) return null;
  if (!agentSessionId) throw new Error('Native seed receipt session ID is required');
  return { ...receipt, agentSessionId };
}

export function retargetNativeSeedReceiptIfPreserved(
  receipt: NativeSeedReceipt | null,
  agentSessionId: string,
  messages: readonly ChatMessage[],
): NativeSeedReceipt | null {
  if (!receipt) return null;
  const firstUserMessage = messages.find((message) => message.type === 'user-message');
  if (!(firstUserMessage instanceof UserMessage)) return null;
  const prefix = firstUserMessage.content.slice(0, receipt.codeUnitLength);
  if (prefix.length !== receipt.codeUnitLength || sha256(prefix) !== receipt.sha256) return null;
  if (
    receipt.placement === 'provider-context'
    && firstUserMessage.content.length !== receipt.codeUnitLength
  ) return null;
  return retargetNativeSeedReceipt(receipt, agentSessionId);
}

export function parseNativeSeedReceipt(value: unknown): NativeSeedReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.agentSessionId !== 'string' || !receipt.agentSessionId) return null;
  if (receipt.placement !== 'user-prefix' && receipt.placement !== 'provider-context') return null;
  if (
    receipt.format !== 'v2-xml'
    && receipt.format !== 'v1-marker'
    && receipt.format !== 'legacy-v0'
  ) return null;
  if (!Number.isSafeInteger(receipt.codeUnitLength) || Number(receipt.codeUnitLength) < 0) return null;
  if (typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null;
  return {
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
    return mismatch(messages, 'Seed receipt does not name the current native session');
  }
  if (receipt.placement === 'provider-context') return { kind: 'not-applicable', messages };

  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return { kind: 'absent', messages };
  const original = messages[index] as UserMessage;
  const prefix = original.content.slice(0, receipt.codeUnitLength);
  if (prefix.length === receipt.codeUnitLength && sha256(prefix) === receipt.sha256) {
    const next = messages.slice();
    next[index] = new UserMessage(
      original.timestamp,
      original.content.slice(receipt.codeUnitLength),
      original.images,
      original.metadata,
    );
    return { kind: 'stripped-exact', messages: next };
  }

  if (receipt.format !== 'legacy-v0' && original.content.startsWith(CARRIED_CONTEXT_OPEN_PREFIX)) {
    return mismatch(messages, 'Recorded carried-context XML was rewritten');
  }
  return { kind: 'absent', messages };
}

// Retains the pre-v2 helpers only for importing legacy provider transcripts.
export function renderTranscriptSeed(
  messages: ChatMessage[],
  options: { maxChars?: number; fromAgentLabel?: string } = {},
): string {
  const lines = messages.map(renderLegacyMessageLine).filter(Boolean);
  if (lines.length === 0) return '';
  const preamble = `The following is a prior conversation with ${options.fromAgentLabel || 'another assistant'}. Continue it.`;
  const { kept, truncated } = capLegacyLines(lines, options.maxChars ?? DEFAULT_MAX_CHARS);
  return [
    preamble,
    SEED_CONTEXT_OPEN,
    ...(truncated ? ['[earlier turns truncated]', ...kept] : kept),
    SEED_CONTEXT_CLOSE,
  ].join('\n');
}

export function stripTranscriptSeed(userText: string): string {
  const openIndex = userText.indexOf(SEED_CONTEXT_OPEN);
  if (openIndex === -1) return userText;
  const prefix = userText.slice(0, openIndex);
  if (prefix.trim().length > 0 && !prefix.trimEnd().endsWith('Continue it.')) return userText;
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
  next[index] = new UserMessage(original.timestamp, stripped, original.images, original.metadata);
  return next;
}

function isProjectableMessage(message: ChatMessage): boolean {
  return message.type === 'user-message'
    || message.type === 'assistant-message'
    || message.type === 'tool-result'
    || isToolUseMessage(message);
}

function renderMessageElement(message: ChatMessage, maximum = Number.POSITIVE_INFINITY): string {
  if (isToolUseMessage(message)) {
    return fitElement(
      '    <assistant><tool-use>',
      `${toolName(message)}: ${toolSummary(message)}`,
      '</tool-use></assistant>',
      maximum,
    );
  }
  switch (message.type) {
    case 'user-message':
      return fitElement('    <user>', boundedCollapse(message.content), '</user>', maximum);
    case 'assistant-message':
      return fitElement('    <assistant>', boundedCollapse(message.content), '</assistant>', maximum);
    case 'tool-result':
      return fitElement(
        '    <tool-result>',
        truncate(boundedCollapse(stringifyToolResult(message.content)), TOOL_SUMMARY_MAX_CHARS),
        '</tool-result>',
        maximum,
      );
    default:
      return '';
  }
}

function fitElement(open: string, content: string, close: string, maximum: number): string {
  const overhead = open.length + close.length;
  if (maximum < overhead) return '';
  const escaped = escapeXml(content);
  if (overhead + escaped.length <= maximum) return `${open}${escaped}${close}`;
  const suffix = '...';
  if (maximum < overhead + suffix.length) return '';
  const codePoints = Array.from(content);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = escapeXml(codePoints.slice(0, middle).join(''));
    if (overhead + candidate.length + suffix.length <= maximum) low = middle;
    else high = middle - 1;
  }
  return `${open}${escapeXml(codePoints.slice(0, low).join(''))}${suffix}${close}`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderLegacyMessageLine(message: ChatMessage): string {
  if (isToolUseMessage(message)) return `Assistant used ${toolName(message)}: ${toolSummary(message)}`;
  switch (message.type) {
    case 'user-message': return `User: ${boundedCollapse(message.content)}`;
    case 'assistant-message': return `Assistant: ${boundedCollapse(message.content)}`;
    case 'tool-result': return `Tool result: ${boundedCollapse(stringifyToolResult(message.content))}`;
    default: return '';
  }
}

function capLegacyLines(lines: string[], maxChars: number): { kept: string[]; truncated: boolean } {
  if (maxChars <= 0) return { kept: lines, truncated: false };
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > maxChars && kept.length > 0) return { kept, truncated: true };
    kept.unshift(line);
    total += cost;
  }
  return { kept, truncated: false };
}

function toolName(message: ToolUseChatMessage): string {
  return message.type.replace(/-tool-use$/, '');
}

function toolSummary(message: ToolUseChatMessage): string {
  return truncate(boundedCollapse(extractToolDetail(message)), TOOL_SUMMARY_MAX_CHARS);
}

function extractToolDetail(message: ToolUseChatMessage): string {
  switch (message.type) {
    case 'bash-tool-use': return message.description || message.command;
    case 'read-tool-use':
    case 'write-tool-use': return message.filePath;
    case 'edit-tool-use':
    case 'apply-patch-tool-use': return message.filePath ?? '';
    case 'list-tool-use': return message.path ?? '';
    case 'grep-tool-use':
    case 'glob-tool-use': return message.pattern ?? '';
    case 'web-search-tool-use': return message.query;
    case 'web-fetch-tool-use': return message.url;
    case 'task-tool-use': return message.description || message.prompt || message.subagentType || '';
    case 'external-tool-use': return message.name;
    case 'mcp-tool-use': return `${message.server}/${message.tool}`;
    case 'unknown-tool-use': return message.rawName;
    default: return '';
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

function boundedCollapse(value: string): string {
  return value.slice(0, MESSAGE_PROJECTION_MAX_CHARS * 2).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function mismatch(
  messages: readonly ChatMessage[],
  reason: string,
): SanitizeCarriedContextResult {
  return { kind: 'mismatch', messages, reason };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
