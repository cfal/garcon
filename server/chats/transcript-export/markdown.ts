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

export function renderTranscriptExportMarkdown(model: TranscriptExportDocumentModel): string {
  const omitted = model.omitted.map(({ category, count }) => `${category} ${count}`).join(', ');
  const lines = [
    `# Transcript export — ${singleLine(model.chat.title)}`,
    '',
    `- chat id: \`${inline(model.chat.id)}\``,
    `- agent: \`${inline(model.chat.agentId)}\``,
    `- model: ${model.chat.model ? `\`${inline(model.chat.model)}\`` : 'not specified'}`,
    `- project path: \`${inline(model.chat.projectPath)}\``,
    `- transcript view id: \`${inline(model.transcriptViewId)}\``,
    `- last ordinal: ${model.lastOrdinal}`,
    `- exported at: \`${inline(model.generatedAt)}\``,
    `- entries: ${model.entries.length} of ${model.totalEntryCount}`,
    `- excluded categories: ${model.exclusions.length > 0 ? model.exclusions.join(', ') : 'none'}`,
    `- omitted: ${omitted || 'none'}`,
    '- attachment and image bodies: omitted',
    '- entry boundary contract: XML only; Markdown content is verbatim and may resemble headings',
    '',
  ];

  for (const entry of model.entries) {
    const type = transcriptExportEntryType(entry);
    const timestamp = transcriptExportEntryTimestamp(entry);
    lines.push(`## [${entry.ordinal}] ${entryLabel(type)} — ${entry.category} — ${timestamp}`, '');

    const content = transcriptExportEntryText(entry);
    if (content !== null) lines.push(content, '');

    const toolId = transcriptExportEntryToolId(entry);
    if (toolId !== null) lines.push(...renderField('tool id', toolId, 'text'), '');

    for (const field of transcriptExportEntryFields(entry)) {
      lines.push(...renderField(field.name, field.value, field.encoding), '');
    }

    const images = transcriptExportEntryImages(entry);
    if (images.length > 0) {
      lines.push('Attachments:', '');
      for (const image of images) {
        const mime = image.mimeType ?? 'unknown media type';
        lines.push(`- ${singleLine(image.name)} (${singleLine(mime)}, ${image.encodedBytes} encoded bytes) [body omitted from export]`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderField(
  name: string,
  value: string,
  encoding: 'text' | 'json',
): string[] {
  if (!value.includes('\n') && !value.includes('`')) {
    return [`- ${name}: \`${value}\``];
  }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(value) + 1));
  return [`- ${name}:`, '', `${fence}${encoding === 'json' ? 'json' : 'text'}`, value, fence];
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === '`') {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function entryLabel(type: string): string {
  if (type === 'user-message') return 'User';
  if (type === 'assistant-message') return 'Assistant';
  return type;
}

function inline(value: string): string {
  return singleLine(value).replaceAll('`', '\\`');
}

function singleLine(value: string): string {
  return textSafe(value).replace(/[\r\n]+/g, ' ');
}
