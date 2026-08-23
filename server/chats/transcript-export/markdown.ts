import type { TranscriptExportDocumentModel } from './model.js';
import type { TranscriptExportField } from './values.js';
import {
  textSafe,
  transcriptExportEntryFields,
  transcriptExportEntryImages,
  transcriptExportEntryTag,
  transcriptExportEntryText,
  transcriptExportEntryToolId,
  transcriptExportEntryType,
  transcriptExportEntryUserPresentation,
} from './values.js';

export function renderTranscriptExportMarkdown(model: TranscriptExportDocumentModel): string {
  const omitted = model.omitted
    .filter(({ count }) => count > 0)
    .map(({ category, count }) => `${category} ${count}`)
    .join(', ');
  const lines = [
    `# Transcript export — ${singleLine(model.chat.title)}`,
    '',
    `Chat \`${inline(model.chat.id)}\` · Agent \`${inline(model.chat.agentId)}\`${model.chat.model === null ? '' : ` · Model \`${inline(model.chat.model)}\``}`,
    ...(omitted ? ['', `> Omitted: ${omitted}`] : []),
    '',
  ];

  for (const entry of model.entries) {
    const type = transcriptExportEntryType(entry);
    const presentation = transcriptExportEntryUserPresentation(entry);
    const presentationLabel = presentation === null
      ? ''
      : ` — CLI ${presentation.style}${presentation.title ? `: ${singleLine(presentation.title)}` : ''}`;
    lines.push(`## [${entry.ordinal}] ${entryLabel(type)}${presentationLabel}`, '');

    const content = transcriptExportEntryText(entry);
    if (content !== null) lines.push(content, '');

    const fields = [...transcriptExportEntryFields(entry)];
    const toolId = transcriptExportEntryToolId(entry);
    if (toolId !== null) {
      fields.unshift({ name: 'tool id', value: toolId, encoding: 'text' });
    }
    if (fields.length > 0) lines.push(...renderFields(fields), '');

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

function renderFields(
  fields: readonly TranscriptExportField[],
): string[] {
  const lines: string[] = [];
  let previousWasMultiline = false;
  for (const field of fields) {
    const rendered = renderField(field.name, field.value, field.encoding);
    const isMultiline = rendered.length > 1;
    if (lines.length > 0 && (previousWasMultiline || isMultiline)) lines.push('');
    lines.push(...rendered);
    previousWasMultiline = isMultiline;
  }
  return lines;
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
  const tag = transcriptExportEntryTag(type);
  if (tag === 'user') return 'User';
  if (tag === 'assistant') return 'Assistant';
  if (tag === 'tool-call') return `Tool call — ${type}`;
  if (tag === 'permission') return `Permission — ${type.slice('permission-'.length)}`;
  return tag.replaceAll('-', ' ').replace(/^./, (character) => character.toUpperCase());
}

function inline(value: string): string {
  return singleLine(value).replaceAll('`', '\\`');
}

function singleLine(value: string): string {
  return textSafe(value).replace(/[\r\n]+/g, ' ');
}
