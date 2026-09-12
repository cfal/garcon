import type { AgentAttachment } from '../../../common/agent-execution.js';
import { isCommandCorrelationIdWithinLimit } from '../../../common/command-request-validation.js';
import type { CarriedContext } from '../../../common/transcript-seed.js';
import { NODE_WIRE_VERSION, isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { validateCommandAttachments } from '../../attachments/validation.js';
import type { ProviderExecutionInput } from '../provider-execution.js';
import { exactNodeFields, nodeString, nodeText, parsePrivateNodeJson } from './private-json.js';

// Accommodates the 25 MiB attachment budget after base64, with room for text and context.
export const MAX_NODE_EXECUTION_BODY_BYTES = 40 * 1024 * 1024;

export type NodeExecutionBody =
  | { readonly kind: 'execution'; readonly input: ProviderExecutionInput }
  | { readonly kind: 'goal'; readonly prompt: string; readonly attachments: readonly AgentAttachment[] }
  | { readonly kind: 'steer'; readonly input: string; readonly clientMessageId: string };

export function parseNodeExecutionBody(bytes: Uint8Array): NodeExecutionBody | null {
  if (bytes.byteLength > MAX_NODE_EXECUTION_BODY_BYTES) return null;
  try { return parseNodeExecutionBodyText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return null; }
}

export function parseNodeExecutionBodyText(text: string): NodeExecutionBody | null {
  return parseBody(parsePrivateNodeJson(text, MAX_NODE_EXECUTION_BODY_BYTES));
}

function parseBody(value: unknown): NodeExecutionBody | null {
  if (!exactNodeFields(value, ['version', 'kind'], ['input', 'clientMessageId', 'prompt', 'attachments'])) return null;
  if (!value || value.version !== NODE_WIRE_VERSION) return null;
  if (value.kind === 'steer') {
    return exactNodeFields(value, ['version', 'kind', 'input', 'clientMessageId'])
      && nodeText(value.input, MAX_NODE_EXECUTION_BODY_BYTES)
      && nodeText(value.clientMessageId, 256) && isCommandCorrelationIdWithinLimit(value.clientMessageId)
      ? { kind: 'steer', input: value.input, clientMessageId: value.clientMessageId } : null;
  }
  if (value.kind === 'goal') {
    if (!exactNodeFields(value, ['version', 'kind', 'prompt', 'attachments'])
      || !nodeText(value.prompt, MAX_NODE_EXECUTION_BODY_BYTES, true)) return null;
    const attachments = parseAttachments(value.attachments);
    return attachments ? { kind: 'goal', prompt: value.prompt, attachments } : null;
  }
  if (value.kind !== 'execution' || !exactNodeFields(value, ['version', 'kind', 'input'])
    || !exactNodeFields(value.input, ['prompt', 'attachments', 'carriedContext'])
    || !nodeText(value.input.prompt, MAX_NODE_EXECUTION_BODY_BYTES, true)) return null;
  const attachments = parseAttachments(value.input.attachments);
  const carriedContext = value.input.carriedContext === null ? null : parseCarriedContext(value.input.carriedContext);
  if (!attachments || (value.input.carriedContext !== null && !carriedContext)) return null;
  return { kind: 'execution', input: { prompt: value.input.prompt, attachments, carriedContext } };
}

export function serializeNodeExecutionBody(body: NodeExecutionBody): Uint8Array {
  if (!isNormalizedJsonObject(body)) throw new TypeError('Invalid node execution body');
  const parsed = parseBody({ ...body, version: NODE_WIRE_VERSION });
  if (!parsed) throw new TypeError('Invalid node execution body');
  const serialized = JSON.stringify({ ...parsed, version: NODE_WIRE_VERSION });
  if (Buffer.byteLength(serialized) > MAX_NODE_EXECUTION_BODY_BYTES) throw new TypeError('Invalid node execution body');
  return new TextEncoder().encode(serialized);
}

function parseAttachments(value: unknown): readonly AgentAttachment[] | null {
  if (!Array.isArray(value) || value.some((attachment) => !exactNodeFields(attachment, ['kind', 'data', 'name', 'mimeType'])
    || attachment.kind !== 'image' || (attachment.name !== null && !nodeString(attachment.name, 4096, true))
    || !nodeString(attachment.mimeType, 256))) return null;
  try {
    const parsed = validateCommandAttachments(value);
    if (!parsed) return null;
    return parsed.map((attachment, index) => {
      if (!attachment.mimeType) throw new TypeError('Missing normalized attachment MIME type');
      return { kind: 'image', data: attachment.data, mimeType: attachment.mimeType, name: (value[index] as AgentAttachment).name };
    });
  } catch { return null; }
}

function parseCarriedContext(value: unknown): CarriedContext | null {
  if (!exactNodeFields(value, ['prefix'], ['summaryTruncated']) || !nodeText(value.prefix, MAX_NODE_EXECUTION_BODY_BYTES)
    || (Object.hasOwn(value, 'summaryTruncated') && typeof value.summaryTruncated !== 'boolean')) return null;
  return { prefix: value.prefix, ...(typeof value.summaryTruncated === 'boolean' ? { summaryTruncated: value.summaryTruncated } : {}) };
}
