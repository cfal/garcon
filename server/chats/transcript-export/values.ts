import type {
  ChatImage,
  ChatMessage,
  UserMessagePresentation,
} from '../../../common/chat-types.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';

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
const embeddedDataUrl = /(?<![A-Za-z0-9_])(?<![A-Za-z0-9_][.+-])data:(?:[A-Za-z0-9][\w.+-]*\/[\w.+-]+)?(?:;[\w.+=-]+)*,[^\s"'<>)]*/gi;

export function textSafe(value: string): string {
  return value.toWellFormed().replace(
    xmlIllegalCharacters,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
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
  switch (entry.message.type) {
    case 'user-message':
    case 'assistant-message':
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
  return fieldsFromMessage(entry.message);
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
  const imageSource = isRecord(value.source) ? value.source : null;
  if (
    value.type === 'image'
    && imageSource?.type === 'base64'
    && typeof imageSource.data === 'string'
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === 'source'
          ? Object.fromEntries(
            Object.entries(imageSource).map(([sourceKey, sourceValue]) => [
              sourceKey,
              sourceKey === 'data'
                ? IMAGE_BODY_OMISSION
                : sanitizeStructuredValue(sourceValue),
            ]),
          )
          : sanitizeStructuredValue(child),
      ]),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeStructuredValue(child)]),
  );
}

function redactDataUrl(value: string): string {
  return value.replace(embeddedDataUrl, DATA_URL_OMISSION);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageMetadata(image: ChatImage): TranscriptExportImage {
  return {
    name: textSafe(image.name),
    mimeType: image.mimeType ? textSafe(image.mimeType) : null,
    encodedBytes: utf8Encoder.encode(image.data).byteLength,
  };
}
