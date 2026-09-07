import type { TranscriptMessage } from '@garcon/common/chat-view';
import { CliRowMessage } from '@garcon/common/chat-types';

const MESSAGE_TEXT_LIMIT = 4_000;
const DATA_URL_OMISSION = '[data URL omitted from text output]';
const TRUNCATION_MARKER = '... [truncated; use read --json for the complete bounded value or export for the complete transcript]';

export function formatTranscriptMessage(entry: TranscriptMessage): string {
  const { type, timestamp, ...payload } = entry.message;
  const images = 'images' in payload && Array.isArray(payload.images)
    ? payload.images
    : undefined;
  const textPayload = { ...payload } as Record<string, unknown>;
  delete textPayload.images;
  delete textPayload.title;
  delete textPayload.presentation;
  let content = typeof textPayload.content === 'string'
    ? redactDataUrl(textPayload.content)
    : JSON.stringify(textPayload, redactDataUrls, 2) ?? '{}';
  if (images && images.length > 0) {
    content += `\n[${images.length} image attachments omitted from text output]`;
  }
  const userPresentation = entry.message.type === 'user-message'
    ? entry.message.presentation
    : undefined;
  const titleValue = userPresentation?.title
    ?? ('title' in entry.message && typeof entry.message.title === 'string'
      ? entry.message.title
      : undefined);
  const title = titleValue ? ` — ${titleValue}` : '';
  const cliLabel = userPresentation
    ? ` (CLI${userPresentation.style ? ` ${userPresentation.style}` : ''})`
    : entry.message instanceof CliRowMessage
      ? ` (CLI ${entry.message.presentation.style})`
      : '';
  return `[${entry.ordinal}] ${timestamp} ${type}${cliLabel}${title}\n`
    + truncateTranscriptText(content);
}

function redactDataUrls(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? redactDataUrl(value) : value;
}

function redactDataUrl(value: string): string {
  return value.startsWith('data:') ? DATA_URL_OMISSION : value;
}

function truncateTranscriptText(content: string): string {
  if (content.length <= MESSAGE_TEXT_LIMIT) return content;
  return `${content.slice(0, MESSAGE_TEXT_LIMIT)}${TRUNCATION_MARKER}`;
}
