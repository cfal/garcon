import type {
  ChatImage,
  ChatMessage,
  UserMessagePresentation,
} from '../../../../common/chat-types.js';
import { isRecord } from '../../../../common/json.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';
import {
  isPreambleApplicationNoticeDetail,
  isPreambleSelectionChangedNoticeDetail,
  type AppliedPreambleReference,
} from '../../../../common/transcript-notice-details.js';

export interface TranscriptExportField {
  readonly name: string;
  readonly value: string;
  readonly encoding: 'text' | 'json';
}

export interface TranscriptExportImage {
  readonly name: string;
  readonly mimeType: string | null;
  readonly encodedBytes: number;
}

const xmlIllegalCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const utf8Encoder = new TextEncoder();
const DATA_URL_OMISSION = '[data URL omitted from export]';
const IMAGE_BODY_OMISSION = '[image body omitted from export]';
const standaloneDataUrl = /^data:[^\s,]*,\S*$/i;
const embeddedDataScheme = /(?<![A-Za-z0-9_])(?<![A-Za-z0-9_][.+-])data:/gi;

export function textSafe(value: string): string {
  return value.toWellFormed().replace(
    xmlIllegalCharacters,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function xmlText(value: string): string {
  return textSafe(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

export function xmlAttribute(value: string): string {
  return xmlText(value)
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('"', '&quot;');
}

export function transcriptExportEntryType(entry: TranscriptExportEntry): string {
  return entry.kind === 'run-ended' ? 'run-ended' : entry.message.type;
}

export function transcriptExportEntryTag(type: string): string {
  if (type === 'user-message') return 'user';
  if (type === 'assistant-message') return 'assistant';
  if (type === 'thinking') return 'reasoning';
  if (type.endsWith('-tool-use')) return 'tool-call';
  if (type === 'tool-result') return 'tool-result';
  if (type === 'transcript-notice') return 'notice';
  if (type === 'agent-switch') return 'handoff';
  if (type.startsWith('permission-')) return 'permission';
  return type;
}

export function transcriptExportEntryCliPresentation(
  entry: TranscriptExportEntry,
): UserMessagePresentation | null {
  if (entry.kind !== 'message') return null;
  if (entry.message.type === 'user-message') return entry.message.presentation ?? null;
  if (entry.message.type !== 'cli-row') return null;
  return {
    origin: 'cli',
    ...entry.message.presentation,
    ...(entry.message.title === undefined ? {} : { title: entry.message.title }),
  };
}

export function transcriptExportEntryText(entry: TranscriptExportEntry): string | null {
  if (entry.kind === 'run-ended') return null;
  const snapshot = transcriptExportEntryPreambleSnapshot(entry);
  if (snapshot) {
    const label = snapshot.kind === 'applied'
      ? 'Preambles applied'
      : 'Preambles updated';
    const titles = snapshot.preambles.length === 0
      ? 'None applicable'
      : snapshot.preambles.map((preamble) => preamble.title).join('; ');
    return textSafe(`${label}: ${titles}`);
  }
  switch (entry.message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'command-output':
    case 'command-result':
    case 'thinking':
    case 'error':
    case 'transcript-notice':
    case 'cli-row':
      return textSafe(entry.message.content);
    case 'compaction':
      return textSafe(entry.message.summary);
    default:
      return null;
  }
}

export function transcriptExportEntryToolId(entry: TranscriptExportEntry): string | null {
  if (entry.kind === 'run-ended') return null;
  return 'toolId' in entry.message && typeof entry.message.toolId === 'string'
    ? textSafe(entry.message.toolId)
    : null;
}

export function transcriptExportEntryImages(
  entry: TranscriptExportEntry,
): readonly TranscriptExportImage[] {
  if (entry.kind !== 'message' || entry.message.type !== 'user-message') return [];
  return (entry.message.images ?? []).map(imageMetadata);
}

export function transcriptExportEntryFields(
  entry: TranscriptExportEntry,
): readonly TranscriptExportField[] {
  if (entry.kind === 'run-ended') {
    return fieldsFromObject({
      outcome: entry.outcome,
      origin: entry.origin,
      error: entry.error,
    });
  }
  if (transcriptExportEntryPreambles(entry)) return [];
  return fieldsFromMessage(entry.message);
}

export interface TranscriptExportPreambleSnapshot {
  readonly kind: 'applied' | 'updated';
  readonly preambles: readonly AppliedPreambleReference[];
}

// Structural snapshot accessor for both title-only preamble notice facts; the
// update variant may list zero entries (`None enabled`).
export function transcriptExportEntryPreambles(
  entry: TranscriptExportEntry,
): readonly AppliedPreambleReference[] | null {
  return transcriptExportEntryPreambleSnapshot(entry)?.preambles ?? null;
}

export function transcriptExportEntryPreambleSnapshot(
  entry: TranscriptExportEntry,
): TranscriptExportPreambleSnapshot | null {
  if (entry.kind !== 'message' || entry.message.type !== 'transcript-notice') return null;
  if (isPreambleApplicationNoticeDetail(entry.message.detail)) {
    return { kind: 'applied', preambles: entry.message.detail.preambles };
  }
  if (isPreambleSelectionChangedNoticeDetail(entry.message.detail)) {
    return { kind: 'updated', preambles: entry.message.detail.preambles };
  }
  return null;
}

function fieldsFromMessage(message: ChatMessage): TranscriptExportField[] {
  const excluded = new Set(['type', 'timestamp', 'images', 'toolId']);
  if (message.type === 'user-message') {
    excluded.add('metadata');
    excluded.add('presentation');
  }
  if (message.type === 'cli-row') {
    excluded.add('content');
    excluded.add('presentation');
    excluded.add('title');
    excluded.add('disclosure');
  }
  if (
    message.type === 'user-message'
    || message.type === 'assistant-message'
    || message.type === 'command-output'
    || message.type === 'command-result'
    || message.type === 'thinking'
    || message.type === 'error'
    || message.type === 'transcript-notice'
  ) {
    excluded.add('content');
  }
  if (message.type === 'compaction') excluded.add('summary');
  return fieldsFromObject(
    Object.fromEntries(Object.entries(message).filter(([key]) => !excluded.has(key))),
  );
}

function fieldsFromObject(value: Record<string, unknown>): TranscriptExportField[] {
  const fields: TranscriptExportField[] = [];
  for (const [name, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null) continue;
    if (typeof rawValue === 'string') {
      fields.push({
        name,
        value: textSafe(redactDataUrl(rawValue)),
        encoding: 'text',
      });
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      fields.push({ name, value: String(rawValue), encoding: 'text' });
      continue;
    }
    const serialized = JSON.stringify(sanitizeStructuredValue(rawValue));
    if (serialized !== undefined) {
      fields.push({ name, value: textSafe(serialized), encoding: 'json' });
    }
  }
  return fields;
}

function sanitizeStructuredValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDataUrl(value);
  if (Array.isArray(value)) return value.map(sanitizeStructuredValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, sanitizeStructuredValue(omitImageBody(value.type, key, child))]));
}

function omitImageBody(blockType: unknown, key: string, value: unknown): unknown {
  if (blockType === 'image') {
    if (key === 'data' && typeof value === 'string') return IMAGE_BODY_OMISSION;
    if (key === 'source' && isRecord(value) && value.type === 'base64' && typeof value.data === 'string') {
      return { ...value, data: IMAGE_BODY_OMISSION };
    }
  }
  if (blockType === 'resource' && key === 'resource' && isRecord(value) && typeof value.blob === 'string'
    && typeof value.mimeType === 'string' && /^image\//i.test(value.mimeType)) {
    return { ...value, blob: IMAGE_BODY_OMISSION };
  }
  return value;
}

// A bare data URL can itself contain parentheses. In a link, the last unmatched close delimits the destination.
function linkDestinationEnd(value: string, start: number, end: number): number {
  let depth = 0;
  let close = end;
  for (let i = start; i < end; i++) {
    if (value[i] === '\\') i++;
    else if (close < end && value.startsWith('](', i)) break;
    else if (value[i] === '(') depth++;
    else if (value[i] === ')') {
      if (depth) depth--;
      else close = i;
    }
  }
  return close;
}

function* embeddedDataUrls(value: string) {
  const proseEnd = /[\s"<>]/g;
  const quotedEnd = /[\s"'<>]/g;
  const linkEnd = /[\s<>]|\)(?=!?\[[^\[\]\r\n]*\]\()/g;
  let examined = 0;
  let linkLimit = 0;
  for (const match of value.matchAll(embeddedDataScheme)) {
    const start = match.index;
    if (start < examined) continue;
    const afterScheme = start + match[0].length;
    let opening = start;
    while (opening > 0 && /\s/.test(value[opening - 1])) opening--;
    const link = value.endsWith('](', opening);
    if (link) {
      if (start >= linkLimit) {
        linkEnd.lastIndex = afterScheme;
        linkLimit = linkEnd.exec(value)?.index ?? value.length;
      }
      examined = value[linkLimit] === ')' ? linkLimit : linkDestinationEnd(value, afterScheme, linkLimit);
    } else {
      const delimiter = value[start - 1] === "'" ? quotedEnd : proseEnd;
      delimiter.lastIndex = afterScheme;
      examined = delimiter.exec(value)?.index ?? value.length;
    }
    if (value.slice(afterScheme, examined).includes(',')) yield { start, end: examined, link };
  }
}

export function redactDataUrl(value: string): string {
  const trimmed = value.trim();
  if (standaloneDataUrl.test(trimmed)) return value.replace(trimmed, DATA_URL_OMISSION);
  let copied = 0;
  let depth = 0;
  const parts: string[] = [];
  for (const { start, end, link } of embeddedDataUrls(value)) {
    for (let i = copied; i < start; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')' && depth) depth--;
    }
    parts.push(value.slice(copied, start), DATA_URL_OMISSION);
    copied = end;
    if (link || !depth) continue;
    // The closing parentheses and punctuation of surrounding prose are not URL payload.
    let punctuation = end;
    while (punctuation > start && '.,;:!?'.includes(value[punctuation - 1])) punctuation--;
    let closing = punctuation;
    while (depth && value[closing - 1] === ')') {
      closing--;
      depth--;
    }
    if (closing < punctuation) parts.push(value.slice(closing, end));
  }
  if (!parts.length) return value;
  parts.push(value.slice(copied));
  return parts.join('');
}

function imageMetadata(image: ChatImage): TranscriptExportImage {
  return {
    name: textSafe(image.name),
    mimeType: image.mimeType ? textSafe(image.mimeType) : null,
    encodedBytes: utf8Encoder.encode(image.data).byteLength,
  };
}
