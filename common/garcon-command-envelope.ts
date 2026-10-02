import { normalizeGarconCommandBody } from './garcon-command-text.js';
import { TICKET_ACTIONS, type TicketAction } from './ticket-commands.js';

export const GARCON_COMMAND_ENVELOPE_MAX_BYTES = 64 * 1024;
// Every Garcon element a message can carry, whether a command, result,
// rejection, message, or chat-ID disclosure, opens with this prefix.
export const GARCON_ELEMENT_PREFIX = '<garcon-';
const encoder = new TextEncoder();
const INVALID_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/;
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

export interface GarconCommandEnvelope {
  readonly attributes: Readonly<Record<string, string>>;
  readonly body: string;
  readonly selfClosing: boolean;
}

export type GarconEnvelopeCommand = 'send-message' | 'start-agent' | 'resume-agent' | 'stop-agent' | 'schedule'
  | `ticket-${TicketAction}`;
const TICKET_ENVELOPES = TICKET_ACTIONS.map((action): GarconEnvelopeCommand => `ticket-${action}`);
export const GARCON_ENVELOPE_COMMANDS: readonly GarconEnvelopeCommand[] = [
  'send-message', 'start-agent', 'resume-agent', 'stop-agent', 'schedule', ...TICKET_ENVELOPES,
];

export interface GarconEnvelopeSpan {
  readonly command: GarconEnvelopeCommand;
  readonly start: number;
  readonly end: number | null;
}

export function garconEnvelopeCommandAt(content: string, start: number): GarconEnvelopeCommand | null {
  for (const command of GARCON_ENVELOPE_COMMANDS) {
    const prefix = `<garcon-${command}`;
    if (content.startsWith(prefix, start) && /[\s/>]|^$/.test(content[start + prefix.length] ?? '')) return command;
  }
  return null;
}

export function garconEnvelopeSpanAt(content: string, start: number, end: number): GarconEnvelopeSpan | null {
  return new GarconEnvelopeScanner(content).spanAt(start, end);
}

export class GarconEnvelopeScanner {
  readonly #suffixes = new Map<GarconEnvelopeCommand, Map<number, boolean>>();
  #suffixEnd: number | null = null;

  constructor(readonly content: string) {}

  spanAt(start: number, end: number): GarconEnvelopeSpan | null {
    const boundary = scanGarconEnvelopeSpanAt(this.content, start, end);
    if (!boundary) return null;
    const span = { command: boundary.command, start, end: boundary.end };
    if (span.end === null || !isPromptCommand(span.command)) return span;
    if (this.#suffixEnd !== end) {
      this.#suffixes.clear();
      this.#suffixEnd = end;
    }
    let suffixes = this.#suffixes.get(span.command);
    if (!suffixes) {
      suffixes = new Map();
      this.#suffixes.set(span.command, suffixes);
    }
    if (hasUnmatchedPromptCloser(this.content, span.command, span.end, end, suffixes)) {
      return { ...span, end: null };
    }
    return span;
  }

  spans(start: number, end: number, isRemovedEnvelope: (span: GarconEnvelopeSpan) => boolean) {
    return scanGarconEnvelopeSpans(this, start, end, isRemovedEnvelope);
  }
}

function isPromptCommand(command: GarconEnvelopeCommand): boolean {
  return command === 'start-agent' || command === 'resume-agent';
}

interface GarconEnvelopeBoundary extends GarconEnvelopeSpan {
  readonly completeFraming: boolean;
}

function scanGarconEnvelopeSpanAt(content: string, start: number, end: number): GarconEnvelopeBoundary | null {
  const command = garconEnvelopeCommandAt(content, start);
  if (!command) return null;
  const opener = scanGarconEnvelopeOpener(content, start, end);
  if (!opener) return { command, start, end: null, completeFraming: false };
  if (opener.selfClosing) return { command, start, end: opener.end, completeFraming: true };

  const literalPrompt = isPromptCommand(command);
  const nesting: GarconEnvelopeCommand[] = [command];
  let completeFraming = opener.complete;
  let cursor = opener.end;
  while (cursor < end) {
    const next = content.indexOf('<', cursor);
    if (next < 0 || next >= end) break;
    const opaqueEnd = opaqueMarkupEnd(content, next, end);
    if (opaqueEnd !== undefined) {
      if (opaqueEnd === null) break;
      cursor = opaqueEnd;
      continue;
    }
    if (!literalPrompt && content.startsWith('<!', next)) break;
    const closer = `</garcon-${nesting.at(-1)}>`;
    if (next + closer.length <= end && content.startsWith(closer, next)) {
      nesting.pop();
      cursor = next + closer.length;
      if (nesting.length === 0) return { command, start, end: cursor, completeFraming };
      continue;
    }
    if (content.startsWith('</garcon-', next)
      && GARCON_ENVELOPE_COMMANDS.some((name) => content.startsWith(`</garcon-${name}>`, next))) {
      if (literalPrompt) break;
      // Standalone native bodies keep their boundaries but cannot shield a prompt's suffix.
      completeFraming = false;
    }
    const nestedCommand = garconEnvelopeCommandAt(content, next);
    if (literalPrompt && !nestedCommand) {
      cursor = next + 1;
      continue;
    }
    const nestedOpener = scanGarconEnvelopeOpener(content, next, end);
    if (!nestedOpener) break;
    if (nestedCommand) {
      completeFraming &&= nestedOpener.complete;
      if (!nestedOpener.selfClosing) nesting.push(nestedCommand);
    }
    cursor = nestedOpener.end;
  }
  return { command, start, end: null, completeFraming };
}

function hasUnmatchedPromptCloser(
  content: string, command: GarconEnvelopeCommand, start: number, end: number, cache: Map<number, boolean>,
): boolean {
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  const closer = `</garcon-${command}>`;
  const visited: number[] = [];
  const finish = (unmatched: boolean): boolean => {
    for (const position of visited) cache.set(position, unmatched);
    return unmatched;
  };

  // Only a complete sibling envelope or opaque markup can shelter a later closer.
  let cursor = start;
  let closerAt = start - 1;
  let next = start - 1;
  let lineEnd = start - 1;
  while (cursor < end) {
    const suffix = cache.get(cursor);
    if (suffix !== undefined) return finish(suffix);
    visited.push(cursor);
    if (closerAt < cursor) closerAt = content.indexOf(closer, cursor);
    if (closerAt < 0 || closerAt + closer.length > end) return finish(false);
    if (lineEnd < cursor) {
      const newline = content.indexOf('\n', cursor);
      lineEnd = newline < 0 ? end : Math.min(newline, end);
    }
    if (cursor === 0 || content[cursor - 1] === '\n') {
      const fenceEnd = markdownFenceEnd(content, cursor, end);
      if (fenceEnd !== undefined) {
        if (fenceEnd === null) return finish(true);
        cursor = fenceEnd;
        continue;
      }
    }
    if (next < cursor) next = content.indexOf('<', cursor);
    if (next < 0 || next >= end) return finish(false);
    if (next >= lineEnd) {
      cursor = lineEnd + 1;
      continue;
    }
    const opaqueEnd = opaqueMarkupEnd(content, next, end);
    if (opaqueEnd !== undefined) {
      if (opaqueEnd === null) return finish(true);
      cursor = opaqueEnd;
      continue;
    }
    if (content.startsWith(closer, next)) return finish(true);
    const sibling = scanGarconEnvelopeSpanAt(content, next, end);
    if (sibling) {
      if (sibling.end === null || !sibling.completeFraming) return finish(true);
      cursor = sibling.end;
      continue;
    }
    if (!/^<\/?[A-Za-z][\w:.-]*(?:\s*\/?>|\s+[A-Za-z_:][\w:.-]*\s*=)/.test(content.slice(next, end))) {
      cursor = next + 1;
      continue;
    }
    const markup = scanGarconEnvelopeOpener(content, next, end);
    if (!markup) return finish(true);
    cursor = markup.end;
  }
  return finish(false);
}

function markdownFenceEnd(content: string, start: number, end: number): number | null | undefined {
  const newline = content.indexOf('\n', start);
  const lineEnd = newline < 0 ? end : Math.min(newline, end);
  const opener = MARKDOWN_FENCE.exec(content.slice(start, lineEnd));
  if (!opener) return undefined;
  let cursor = lineEnd + 1;
  while (cursor < end) {
    const nextLine = content.indexOf('\n', cursor);
    const nextEnd = nextLine < 0 ? end : Math.min(nextLine, end);
    const closer = MARKDOWN_FENCE.exec(content.slice(cursor, nextEnd));
    if (closer && closer[1][0] === opener[1][0] && closer[1].length >= opener[1].length && !closer[2].trim()) {
      return Math.min(nextEnd + 1, end);
    }
    cursor = nextEnd + 1;
  }
  return null;
}

function opaqueMarkupEnd(content: string, start: number, end: number): number | null | undefined {
  let open: string;
  let close: string;
  if (content.startsWith('<!--', start)) {
    open = '<!--';
    close = '-->';
  } else if (content.startsWith('<![CDATA[', start)) {
    open = '<![CDATA[';
    close = ']]>';
  } else if (content.startsWith('<?', start)) {
    open = '<?';
    close = '?>';
  } else {
    return undefined;
  }
  const closeAt = content.indexOf(close, start + open.length);
  return closeAt < 0 || closeAt + close.length > end ? null : closeAt + close.length;
}

function scanGarconEnvelopeSpans(
  scanner: GarconEnvelopeScanner, start: number, end: number,
  isRemovedEnvelope: (span: GarconEnvelopeSpan) => boolean,
): {
  readonly spans: readonly GarconEnvelopeSpan[];
  readonly openFence: boolean;
} {
  const content = scanner.content;
  const spans: GarconEnvelopeSpan[] = [];
  let cursor = start;
  let opaqueThrough = start;
  let fence: { character: string; length: number } | null = null;
  while (cursor < end) {
    const nextLine = content.indexOf('\n', cursor);
    const lineEnd = nextLine < 0 ? end : Math.min(nextLine, end);
    const line = content.slice(cursor, lineEnd);
    const delimiter = MARKDOWN_FENCE.exec(line);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (!fence && cursor >= opaqueThrough) {
      const span = scanner.spanAt(cursor, end);
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
  if (!value.isWellFormed() || value.includes('<') || INVALID_TEXT_CONTROLS.test(value)) return null;
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
  const envelope = parseGarconEnvelopeFrame(content, name, allowedAttributes);
  if (!envelope) return null;
  const body = decodeGarconXmlText(envelope.body);
  return body === null ? null : { ...envelope, body };
}

export function parseGarconPromptEnvelope(
  content: string,
  name: 'garcon-start-agent' | 'garcon-resume-agent',
  allowedAttributes: readonly string[],
): GarconCommandEnvelope | null {
  const envelope = parseGarconEnvelopeFrame(content, name, allowedAttributes);
  if (!envelope || INVALID_TEXT_CONTROLS.test(envelope.body)) return null;
  const boundary = scanGarconEnvelopeSpanAt(content, 0, content.length);
  if (!boundary?.completeFraming || boundary.end !== content.length) return null;
  return { ...envelope, body: normalizeGarconCommandBody(envelope.body) };
}

function parseGarconEnvelopeFrame(
  content: string,
  name: string,
  allowedAttributes: readonly string[],
): GarconCommandEnvelope | null {
  const prefix = `<${name}`;
  // The prefix check runs first because it is constant-time and rules out
  // almost every message; the size check encodes the whole content.
  if (!content.startsWith(prefix)) return null;
  if (!content.isWellFormed() || encoder.encode(content).byteLength > GARCON_COMMAND_ENVELOPE_MAX_BYTES) return null;
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
  return { attributes, body: content.slice(openerEnd, -close.length), selfClosing };
}
