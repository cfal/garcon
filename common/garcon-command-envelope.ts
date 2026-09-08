import { normalizeGarconCommandBody } from './garcon-command-text.js';

export const GARCON_COMMAND_ENVELOPE_MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

export interface GarconCommandEnvelope {
  readonly attributes: Readonly<Record<string, string>>;
  readonly body: string;
  readonly selfClosing: boolean;
}

export type GarconEnvelopeCommand = 'send-message' | 'start-agent' | 'resume-agent' | 'schedule';

export interface GarconEnvelopeSpan {
  readonly command: GarconEnvelopeCommand;
  readonly start: number;
  readonly end: number | null;
}

export function garconEnvelopeCommandAt(content: string, start: number): GarconEnvelopeCommand | null {
  for (const command of ['send-message', 'start-agent', 'resume-agent', 'schedule'] as const) {
    const prefix = `<garcon-${command}`;
    if (content.startsWith(prefix, start) && /[\s/>]|^$/.test(content[start + prefix.length] ?? '')) return command;
  }
  return null;
}

export function garconEnvelopeSpanAt(content: string, start: number, end: number): GarconEnvelopeSpan | null {
  const command = garconEnvelopeCommandAt(content, start);
  if (!command) return null;
  const opener = scanGarconEnvelopeOpener(content, start, end);
  if (!opener) return { command, start, end: null };
  if (opener.selfClosing) return { command, start, end: opener.end };

  const nesting: GarconEnvelopeCommand[] = [command];
  let cursor = opener.end;
  while (cursor < end) {
    const next = content.indexOf('<', cursor);
    if (next < 0 || next >= end) break;
    const opaqueMarkup = content.startsWith('<!--', next) ? ['<!--', '-->']
      : content.startsWith('<![CDATA[', next) ? ['<![CDATA[', ']]>']
      : content.startsWith('<?', next) ? ['<?', '?>'] : null;
    if (opaqueMarkup) {
      const [open, close] = opaqueMarkup;
      const closeAt = content.indexOf(close, next + open.length);
      if (closeAt < 0 || closeAt + close.length > end) break;
      cursor = closeAt + close.length;
      continue;
    }
    // Unsupported declarations have no trustworthy recovery grammar.
    if (content.startsWith('<!', next)) break;
    const closer = `</garcon-${nesting.at(-1)}>`;
    if (next + closer.length <= end && content.startsWith(closer, next)) {
      nesting.pop();
      cursor = next + closer.length;
      if (nesting.length === 0) return { command, start, end: cursor };
      continue;
    }
    const nestedCommand = garconEnvelopeCommandAt(content, next);
    const nestedOpener = scanGarconEnvelopeOpener(content, next, end);
    if (!nestedOpener) break;
    if (nestedCommand && !nestedOpener.selfClosing) nesting.push(nestedCommand);
    cursor = nestedOpener.end;
  }
  return { command, start, end: null };
}

export function scanGarconEnvelopeSpans(
  content: string, start: number, end: number,
  isRemovedEnvelope: (span: GarconEnvelopeSpan) => boolean,
): {
  readonly spans: readonly GarconEnvelopeSpan[];
  readonly openFence: boolean;
} {
  const spans: GarconEnvelopeSpan[] = [];
  let cursor = start;
  let opaqueThrough = start;
  let fence: { character: string; length: number } | null = null;
  while (cursor < end) {
    const nextLine = content.indexOf('\n', cursor);
    const lineEnd = nextLine < 0 ? end : Math.min(nextLine, end);
    const line = content.slice(cursor, lineEnd);
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (!fence && cursor >= opaqueThrough) {
      const span = garconEnvelopeSpanAt(content, cursor, end);
      if (span) {
        spans.push(span);
        if (span.end === null) return { spans, openFence: false };
        if (!isRemovedEnvelope(span)) {
          // Retained text contributes Markdown fences, but nested commands stay opaque.
          opaqueThrough = span.end;
          cursor = lineEnd + 1;
          continue;
        }
        cursor = span.end;
        if (cursor === end) break;
        if (content[cursor] === '\n') cursor += 1;
        else {
          const followingLine = content.indexOf('\n', cursor);
          cursor = followingLine < 0 ? end : followingLine + 1;
        }
        continue;
      }
    }
    cursor = lineEnd + 1;
  }
  return { spans, openFence: fence !== null };
}

export function decodeGarconXmlText(value: string): string | null {
  if (!value.isWellFormed() || /[<\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) return null;
  if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_, name: string) => XML_ENTITIES[name]);
}

export function escapeGarconXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

interface GarconEnvelopeOpener {
  readonly end: number;
  readonly complete: boolean;
  readonly selfClosing: boolean;
}

function scanGarconEnvelopeOpener(content: string, start: number, end: number): GarconEnvelopeOpener | null {
  let quote: string | null = null;
  for (let index = start + 1; index < end; index += 1) {
    if (content[index] === '<') {
      // A raw tag inside an attribute cannot provide a trustworthy recovery boundary.
      return quote ? null : { end: index, complete: false, selfClosing: false };
    }
    if (content[index] === quote) quote = null;
    else if (!quote && (content[index] === '"' || content[index] === "'")) quote = content[index];
    if (content[index] === '>' && !quote) {
      return { end: index + 1, complete: true, selfClosing: content[index - 1] === '/' };
    }
  }
  return null;
}

export function garconEnvelopeOpenerEnd(content: string, start = 0): number {
  const opener = scanGarconEnvelopeOpener(content, start, content.length);
  return opener?.complete ? opener.end : -1;
}

export function parseGarconCommandEnvelope(
  content: string,
  name: string,
  allowedAttributes: readonly string[],
): GarconCommandEnvelope | null {
  const envelope = parseGarconXmlEnvelope(content, name, allowedAttributes);
  return envelope ? { ...envelope, body: normalizeGarconCommandBody(envelope.body) } : null;
}

export function parseGarconXmlEnvelope(
  content: string,
  name: string,
  allowedAttributes: readonly string[],
): GarconCommandEnvelope | null {
  if (!content.isWellFormed() || encoder.encode(content).byteLength > GARCON_COMMAND_ENVELOPE_MAX_BYTES) return null;
  const prefix = `<${name}`;
  if (!content.startsWith(prefix)) return null;
  const openerEnd = garconEnvelopeOpenerEnd(content);
  if (openerEnd < 0) return null;
  const opener = content.slice(prefix.length, openerEnd - 1);
  const selfClosing = opener.endsWith('/');
  const attributeText = selfClosing ? opener.slice(0, -1) : opener;
  const attributes: Record<string, string> = Object.create(null);
  const attribute = /\s+([a-z][a-z-]*)="([^"]*)"/gy;
  let offset = 0;
  while (offset < attributeText.length) {
    if (!attributeText.slice(offset).trim()) break;
    attribute.lastIndex = offset;
    const match = attribute.exec(attributeText);
    if (!match || !allowedAttributes.includes(match[1]) || Object.hasOwn(attributes, match[1])) return null;
    const value = decodeGarconXmlText(match[2]);
    if (value === null || !value.trim()) return null;
    attributes[match[1]] = value;
    offset = attribute.lastIndex;
  }
  if (selfClosing) {
    return openerEnd === content.length ? { attributes, body: '', selfClosing } : null;
  }
  const close = `</${name}>`;
  if (!content.endsWith(close) || content.length < openerEnd + close.length) return null;
  const body = decodeGarconXmlText(content.slice(openerEnd, -close.length));
  return body === null ? null : { attributes, body, selfClosing };
}
