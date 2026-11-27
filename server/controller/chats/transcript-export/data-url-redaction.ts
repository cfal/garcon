import MarkdownIt from 'markdown-it';

const OMITTED = '[data URL omitted from export]';
const scheme = /(?<![A-Za-z0-9_])(?<![A-Za-z0-9_][.+-])data:/gi;
const mimeToken = "[\\w!#$%&'*+.^_`|~-]+";
const header = new RegExp(`data:(?:${mimeToken}/${mimeToken})?(?:;${mimeToken}(?:=${mimeToken})?)*,`, 'iy');
const { parseLinkDestination } = new MarkdownIt('zero').helpers;

function headerEnd(value: string, start: number): number {
  header.lastIndex = start;
  return header.test(value) ? header.lastIndex : -1;
}

function markdownDestinationEnd(value: string, start: number): number | undefined {
  const angled = value[start - 1] === '<';
  if (!angled) {
    let opening = start;
    while (opening && /\s/.test(value[opening - 1])) opening--;
    if (value[opening - 2] !== ']' || (value[opening - 1] !== '(' && value[opening - 1] !== ':')) return;
  }
  const parsed = parseLinkDestination(value, angled ? start - 1 : start, value.length);
  if (!parsed.ok) return;
  if (angled) return parsed.pos - 1;

  // A glued suffix before a second close may be payload, not prose. Never consume an adjacent link.
  const ambiguousSuffix = /\)[^\s()[\]<>"']+\)/y;
  ambiguousSuffix.lastIndex = parsed.pos;
  return ambiguousSuffix.test(value) ? ambiguousSuffix.lastIndex - 1 : parsed.pos;
}

export function redactDataUrl(value: string): string {
  if (!/data:/i.test(value)) return value;
  const trimmed = value.trim();
  if (headerEnd(trimmed, 0) !== -1 && !/\s/.test(trimmed)) return value.replace(trimmed, OMITTED);

  const proseEnd = /[\s"<>]/g;
  const quotedEnd = /[\s"'<>]/g;
  let copied = 0;
  let openParens = 0;
  const parts: string[] = [];
  for (const { index: start } of value.matchAll(scheme)) {
    if (start < copied) continue;
    const payload = headerEnd(value, start);
    if (payload === -1) continue;
    const linkEnd = markdownDestinationEnd(value, start);
    let end = linkEnd;
    if (end === undefined) {
      const delimiter = value[start - 1] === "'" ? quotedEnd : proseEnd;
      delimiter.lastIndex = payload;
      end = delimiter.exec(value)?.index ?? value.length;
    }
    for (let i = copied; i < start; i++) {
      if (value[i] === '(') openParens++;
      else if (value[i] === ')' && openParens) openParens--;
    }
    parts.push(value.slice(copied, start), OMITTED);
    copied = end;
    if (linkEnd !== undefined || !openParens) continue;

    // Keep only the closing parentheses and punctuation of the surrounding prose.
    let punctuation = end;
    while ('.,;:!?'.includes(value[punctuation - 1]) && punctuation > start) punctuation--;
    let closing = punctuation;
    while (openParens && value[closing - 1] === ')') {
      closing--;
      openParens--;
    }
    if (closing < punctuation) parts.push(value.slice(closing, end));
  }
  if (!parts.length) return value;
  parts.push(value.slice(copied));
  return parts.join('');
}
