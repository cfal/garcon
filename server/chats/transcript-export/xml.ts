import { TRANSCRIPT_EXPORT_CATEGORIES } from '../../../common/chat-export-contracts.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';
import type { TranscriptExportDocumentModel } from './model.js';
import {
  textSafe,
  transcriptExportEntryFields,
  transcriptExportEntryImages,
  transcriptExportEntryTag,
  transcriptExportEntryText,
  transcriptExportEntryToolId,
  transcriptExportEntryType,
  transcriptExportEntryCliPresentation,
} from './values.js';

export function renderTranscriptExportXml(model: TranscriptExportDocumentModel): string {
  const omittedAttributes = TRANSCRIPT_EXPORT_CATEGORIES
    .map((category) => ({
      category,
      count: model.omitted.find((omitted) => omitted.category === category)?.count ?? 0,
    }))
    .filter(({ count }) => count > 0)
    .map(({ category, count }) => `${category}="${count}"`)
    .join(' ');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<transcript-export version="1">',
    `  <chat id="${attribute(model.chat.id)}" title="${attribute(model.chat.title)}" agent="${attribute(model.chat.agentId)}"${model.chat.model === null ? '' : ` model="${attribute(model.chat.model)}"`}/>`,
    ...(omittedAttributes === '' ? [] : [`  <omitted ${omittedAttributes}/>`]),
    '  <entries>',
  ];

  for (const entry of model.entries) lines.push(...renderEntry(entry));
  lines.push('  </entries>', '</transcript-export>');
  return `${lines.join('\n')}\n`;
}

function renderEntry(entry: TranscriptExportEntry): string[] {
  const type = transcriptExportEntryType(entry);
  const tag = transcriptExportEntryTag(type);
  const toolId = transcriptExportEntryToolId(entry);
  const presentation = transcriptExportEntryCliPresentation(entry);
  const typeAttribute = tag === 'tool-call' || tag === 'permission'
    ? ` type="${attribute(type)}"`
    : '';
  const presentationAttributes = presentation === null
    ? ''
    : ` origin="${presentation.origin}" style="${presentation.style}"${presentation.title ? ` title="${attribute(presentation.title)}"` : ''}`;
  const attributes = ` ordinal="${entry.ordinal}"${typeAttribute}${toolId === null ? '' : ` tool-id="${attribute(toolId)}"`}${presentationAttributes}`;
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
