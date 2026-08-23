import type { TranscriptExportEntry } from '../../ledger/export-fold.js';
import type { TranscriptExportDocumentModel } from './model.js';
import {
  textSafe,
  transcriptExportEntryFields,
  transcriptExportEntryImages,
  transcriptExportEntryText,
  transcriptExportEntryTimestamp,
  transcriptExportEntryToolId,
  transcriptExportEntryType,
} from './values.js';

export function renderTranscriptExportXml(model: TranscriptExportDocumentModel): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<transcript-export version="1">',
    `  <chat id="${attribute(model.chat.id)}" title="${attribute(model.chat.title)}" agent="${attribute(model.chat.agentId)}"${model.chat.model === null ? '' : ` model="${attribute(model.chat.model)}"`} project-path="${attribute(model.chat.projectPath)}"/>`,
    `  <capture transcript-view-id="${attribute(model.transcriptViewId)}" last-ordinal="${model.lastOrdinal}" exported-at="${attribute(model.generatedAt)}" entries="${model.entries.length}" total-entries="${model.totalEntryCount}"/>`,
    '  <exclusions>',
    ...model.omitted.map(({ category, count }) =>
      `    <exclusion category="${category}" omitted="${count}"/>`),
    '  </exclusions>',
    '  <entries>',
  ];

  for (const entry of model.entries) lines.push(...renderEntry(entry));
  lines.push('  </entries>', '</transcript-export>');
  return `${lines.join('\n')}\n`;
}

function renderEntry(entry: TranscriptExportEntry): string[] {
  const type = transcriptExportEntryType(entry);
  const tag = entryTag(type);
  const timestamp = transcriptExportEntryTimestamp(entry);
  const toolId = transcriptExportEntryToolId(entry);
  const typeAttribute = tag === 'tool-call' || tag === 'permission'
    ? ` type="${attribute(type)}"`
    : '';
  const attributes = ` ordinal="${entry.ordinal}" category="${entry.category}" timestamp="${attribute(timestamp)}"${typeAttribute}${toolId === null ? '' : ` tool-id="${attribute(toolId)}"`}`;
  const body: string[] = [];
  const content = transcriptExportEntryText(entry);
  if (content !== null) body.push(`      <text>${text(content)}</text>`);
  for (const field of transcriptExportEntryFields(entry)) {
    body.push(`      <field name="${attribute(field.name)}"${field.encoding === 'json' ? ' encoding="json"' : ''}>${text(field.value)}</field>`);
  }
  const images = transcriptExportEntryImages(entry);
  if (images.length > 0) {
    body.push('      <images bodies-omitted="true">');
    for (const image of images) {
      body.push(`        <image name="${attribute(image.name)}"${image.mimeType === null ? '' : ` media-type="${attribute(image.mimeType)}"`} encoded-bytes="${image.encodedBytes}"/>`);
    }
    body.push('      </images>');
  }
  if (body.length === 0) return [`    <${tag}${attributes}/>`];
  return [`    <${tag}${attributes}>`, ...body, `    </${tag}>`];
}

function entryTag(type: string): string {
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

function text(value: string): string {
  return textSafe(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

function attribute(value: string): string {
  return text(value)
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('"', '&quot;');
}
