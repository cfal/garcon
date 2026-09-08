import { parseChatId } from './chat-id.js';
import { parseChatRowContent } from './chat-row-contracts.js';
import { isErrorCode, type ErrorCode } from './error-codes.js';
import { isRecord } from './json.js';
import { GARCON_AGENT_REF, type GarconAgentRequestOptions } from './garcon-agent-request.js';
import { decodeGarconXmlText, escapeGarconXmlText, GARCON_COMMAND_ENVELOPE_MAX_BYTES, parseGarconXmlEnvelope } from './garcon-command-envelope.js';
import type { AgentCommandCorrelation } from './garcon-command-results.js';

export const GARCON_AGENT_OUTPUT_MAX_BYTES = 48 * 1024;
export const AGENT_CHILD_REJECTION_REASONS = [
  'disabled', 'unsupported-agent', 'unknown-provider', 'ambiguous-provider', 'ambiguous-model', 'unknown-model',
  'unsupported-permission-mode', 'unsupported-reasoning-effort', 'project-unavailable',
  'source-unavailable', 'action-failed', 'not-delegated', 'target-unavailable', 'busy', 'invalid-configuration',
] as const;
export type AgentChildRejectionReason = typeof AGENT_CHILD_REJECTION_REASONS[number];

export type AgentChildOutput =
  | { readonly availability: 'available'; readonly completeness: 'complete' | 'best-effort'; readonly text: string }
  | { readonly availability: 'unavailable'; readonly reason: 'too-large' | 'retention-pressure' | 'invalid-text' };

export type AgentChildAdmissionOutcome =
  | { readonly status: 'accepted'; readonly chatId: string }
  | { readonly status: 'rejected'; readonly reason: AgentChildRejectionReason; readonly chatId?: string }
  | { readonly status: 'preamble-rejected'; readonly chatId: string; readonly reason: 'slash-command-blocked' | 'composition-invalid' }
  | { readonly status: 'outcome-unknown'; readonly chatId?: string };

export type AgentChildTerminalOutcome =
  | { readonly status: 'completed'; readonly chatId: string; readonly output: AgentChildOutput }
  | { readonly status: 'failed'; readonly chatId: string; readonly errorCode: ErrorCode; readonly output: AgentChildOutput }
  | { readonly status: 'interrupted'; readonly chatId: string; readonly reason: 'user-stop' | 'chat-deleted'; readonly output: AgentChildOutput }
  | { readonly status: 'result-unavailable'; readonly chatId: string; readonly reason: 'receipt-unavailable' | 'receipt-expired' };

export type AgentChildOutcome = AgentChildAdmissionOutcome | AgentChildTerminalOutcome;
type ChildResultBase = AgentCommandCorrelation & GarconAgentRequestOptions & AgentChildOutcome;
export type AgentStartOutcomeNoticeDetail = ChildResultBase & { readonly type: 'agent-start-outcome' };
export type AgentResumeOutcomeNoticeDetail = ChildResultBase & { readonly type: 'agent-resume-outcome' };
export type AgentChildOutcomeNoticeDetail = AgentStartOutcomeNoticeDetail | AgentResumeOutcomeNoticeDetail;

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE_KEYS = ['type', 'ref', 'async', 'requestViewId', 'requestOrdinal', 'status'];
const ATTRIBUTES = {
  ref: 'ref', async: 'async', 'request-view-id': 'requestViewId', 'request-ordinal': 'requestOrdinal',
  status: 'status', 'chat-id': 'chatId', reason: 'reason', 'error-code': 'errorCode',
} as const;
const OUTPUT_ATTRIBUTES = ['output', 'completeness', 'output-reason'];

function onlyKeys(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(raw).every((key) => keys.includes(key));
}

function validChatId(value: unknown): value is string {
  try { parseChatId(value); return true; } catch { return false; }
}

function validOutputText(text: string): boolean {
  return decodeGarconXmlText(escapeGarconXmlText(text)) === text;
}

function parseOutput(value: unknown): AgentChildOutput | null {
  if (!isRecord(value)) return null;
  if (value.availability === 'available' && typeof value.text === 'string'
    && (value.completeness === 'complete' || value.completeness === 'best-effort')
    && onlyKeys(value, ['availability', 'completeness', 'text'])
    && validOutputText(value.text) && encoder.encode(value.text).byteLength <= GARCON_AGENT_OUTPUT_MAX_BYTES) {
    return { availability: value.availability, completeness: value.completeness, text: value.text };
  }
  if (value.availability === 'unavailable' && onlyKeys(value, ['availability', 'reason'])
    && (value.reason === 'too-large' || value.reason === 'retention-pressure' || value.reason === 'invalid-text')) {
    return { availability: value.availability, reason: value.reason };
  }
  return null;
}

export function parseAgentChildOutcome(value: unknown): AgentChildOutcomeNoticeDetail | null {
  if (!isRecord(value) || (value.type !== 'agent-start-outcome' && value.type !== 'agent-resume-outcome')
    || typeof value.ref !== 'string' || !GARCON_AGENT_REF.test(value.ref) || typeof value.async !== 'boolean'
    || typeof value.requestViewId !== 'string' || !UUID.test(value.requestViewId)
    || typeof value.requestOrdinal !== 'number' || !Number.isSafeInteger(value.requestOrdinal) || value.requestOrdinal < 1) return null;
  const base = { type: value.type, ref: value.ref, async: value.async,
    requestViewId: value.requestViewId, requestOrdinal: value.requestOrdinal } as const;
  const keys = (...fields: string[]) => onlyKeys(value, [...BASE_KEYS, ...fields]);
  const hasChild = validChatId(value.chatId);
  const optionalChild = !('chatId' in value) || hasChild;
  let outcome: AgentChildOutcome;
  if (value.status === 'accepted' && hasChild && keys('chatId')) {
    outcome = { status: value.status, chatId: value.chatId as string };
  } else if (value.status === 'rejected' && optionalChild && keys('chatId', 'reason')
    && AGENT_CHILD_REJECTION_REASONS.some((reason) => reason === value.reason)) {
    outcome = { status: value.status, reason: value.reason as AgentChildRejectionReason,
      ...(hasChild ? { chatId: value.chatId as string } : {}) };
  } else if (value.status === 'preamble-rejected' && hasChild && keys('chatId', 'reason')
    && (value.reason === 'slash-command-blocked' || value.reason === 'composition-invalid')) {
    outcome = { status: value.status, chatId: value.chatId as string, reason: value.reason };
  } else if (value.status === 'outcome-unknown' && optionalChild && keys('chatId')) {
    outcome = { status: value.status, ...(hasChild ? { chatId: value.chatId as string } : {}) };
  } else {
    if (value.async || !hasChild) return null;
    const chatId = value.chatId as string;
    if (value.status === 'result-unavailable' && keys('chatId', 'reason')
      && (value.reason === 'receipt-unavailable' || value.reason === 'receipt-expired')) {
      outcome = { status: value.status, chatId, reason: value.reason };
    } else {
      const output = parseOutput(value.output);
      if (!output) return null;
      if (value.status === 'completed' && keys('chatId', 'output')) outcome = { status: value.status, chatId, output };
      else if (value.status === 'failed' && isErrorCode(value.errorCode) && keys('chatId', 'output', 'errorCode')) {
        outcome = { status: value.status, chatId, errorCode: value.errorCode, output };
      } else if (value.status === 'interrupted' && keys('chatId', 'output', 'reason')
        && (value.reason === 'user-stop' || value.reason === 'chat-deleted')) {
        outcome = { status: value.status, chatId, reason: value.reason, output };
      } else return null;
    }
  }
  const detail: AgentChildOutcomeNoticeDetail = value.type === 'agent-start-outcome'
    ? { ...base, ...outcome, type: 'agent-start-outcome' }
    : { ...base, ...outcome, type: 'agent-resume-outcome' };
  return encoder.encode(serializeChildResult(detail)).byteLength <= GARCON_COMMAND_ENVELOPE_MAX_BYTES ? detail : null;
}

function serializeChildResult(detail: AgentChildOutcomeNoticeDetail): string {
  const name = detail.type === 'agent-start-outcome' ? 'garcon-start-agent-result' : 'garcon-resume-agent-result';
  const attributes = Object.entries(ATTRIBUTES).flatMap(([attribute, field]) => {
    const value = field in detail ? detail[field as keyof typeof detail] : undefined;
    return value === undefined ? [] : [`${attribute}="${escapeGarconXmlText(String(value)).replaceAll('"', '&quot;')}"`];
  });
  let body = '';
  if ('output' in detail) {
    attributes.push(`output="${detail.output.availability}"`);
    if (detail.output.availability === 'available') {
      attributes.push(`completeness="${detail.output.completeness}"`);
      body = detail.output.text;
    } else attributes.push(`output-reason="${detail.output.reason}"`);
  }
  return body ? `<${name} ${attributes.join(' ')}>\n${escapeGarconXmlText(body)}\n</${name}>`
    : `<${name} ${attributes.join(' ')} />`;
}

export function garconAgentResultContent(detail: AgentChildOutcomeNoticeDetail): string {
  const parsed = parseAgentChildOutcome(detail);
  if (!parsed) throw new Error('Invalid child result');
  return serializeChildResult(parsed);
}

export function boundAgentChildResult(detail: AgentChildOutcomeNoticeDetail): AgentChildOutcomeNoticeDetail {
  if (!('output' in detail) || detail.output.availability === 'unavailable') return detail;
  const text = detail.output.text;
  const reason = !validOutputText(text) ? 'invalid-text'
    : encoder.encode(text).byteLength > GARCON_AGENT_OUTPUT_MAX_BYTES
      || encoder.encode(serializeChildResult(detail)).byteLength > GARCON_COMMAND_ENVELOPE_MAX_BYTES ? 'too-large' : null;
  return reason ? { ...detail, output: { availability: 'unavailable', reason } } : detail;
}

export function parseGarconAgentResult(content: string): AgentChildOutcomeNoticeDetail | null {
  for (const [name, type] of [['garcon-start-agent-result', 'agent-start-outcome'],
    ['garcon-resume-agent-result', 'agent-resume-outcome']] as const) {
    const envelope = parseGarconXmlEnvelope(content.trim(), name, [...Object.keys(ATTRIBUTES), ...OUTPUT_ATTRIBUTES]);
    if (!envelope) continue;
    const raw: Record<string, unknown> = { type };
    for (const [attribute, field] of Object.entries(ATTRIBUTES)) {
      const value = envelope.attributes[attribute];
      if (value === undefined) continue;
      if (field === 'requestOrdinal') {
        if (!/^[1-9][0-9]*$/.test(value)) return null;
        raw[field] = Number(value);
      } else if (field === 'async') {
        if (value !== 'true' && value !== 'false') return null;
        raw[field] = value === 'true';
      } else raw[field] = value;
    }
    const attrs = envelope.attributes;
    if (attrs.output === 'available' && attrs['output-reason'] === undefined) {
      // Removes only serializer-owned LF framing; a preceding CR belongs to the answer.
      const text = envelope.body.replace(/^\n/, '').replace(/\n$/, '');
      raw.output = { availability: 'available', completeness: attrs.completeness, text };
    } else if (attrs.output === 'unavailable' && attrs.completeness === undefined && envelope.selfClosing) {
      raw.output = { availability: 'unavailable', reason: attrs['output-reason'] };
    } else if (OUTPUT_ATTRIBUTES.some((key) => attrs[key] !== undefined) || !envelope.selfClosing) return null;
    return parseAgentChildOutcome(raw);
  }
  return null;
}

export function agentChildOutcomeContent(detail: AgentChildOutcomeNoticeDetail): string {
  const subject = `${detail.type === 'agent-start-outcome' ? 'Start' : 'Resume'} agent (${detail.ref})`;
  const chat = 'chatId' in detail && detail.chatId ? `; chat ${detail.chatId}` : '';
  const reason = 'reason' in detail ? `: ${detail.reason}` : 'errorCode' in detail ? `: ${detail.errorCode}` : '';
  const summary = `${subject}: ${detail.status}${chat}${reason}.`;
  const content = 'output' in detail && detail.output.availability === 'available' && detail.output.text
    ? `${summary}\n\n${detail.output.text}` : summary;
  return parseChatRowContent(content);
}
