import { isRecord } from './json.js';

interface ToolTextPart extends Record<string, unknown> {
  type: 'text';
  text: string;
}

function isTextPart(part: unknown): part is ToolTextPart {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}

export function isPlainTextPart(part: unknown): part is ToolTextPart {
  if (!isTextPart(part)) return false;
  for (const key in part) {
    if (Object.hasOwn(part, key) && key !== 'type' && key !== 'text') return false;
  }
  return true;
}

export function toolResultTextPart(block: unknown): ToolTextPart | null {
  const part = isRecord(block) && block.type === 'content' ? block.content : block;
  return isTextPart(part) ? part : null;
}

// Search inspects only its indexed prefix; the transcript inspects the full body.
export function isEmptyToolResult(content: unknown, limits?: { maxChars: number; maxBlocks: number }): boolean {
  if (content == null) return true;
  if (!isRecord(content)) return false;
  for (const key in content) {
    if (Object.hasOwn(content, key) && key !== 'raw' && key !== 'items' && key !== 'content') return false;
  }
  const maxChars = limits?.maxChars ?? Infinity;
  if (Object.hasOwn(content, 'raw') && (typeof content.raw !== 'string' || /\S/.test(content.raw.slice(0, maxChars)))) return false;
  let chars = maxChars;
  let blocks = limits?.maxBlocks ?? Infinity;
  for (const key in content) {
    if (key === 'raw' || !Object.hasOwn(content, key)) continue;
    const items = content[key];
    if (!Array.isArray(items)) return false;
    for (const block of items) {
      if (blocks-- <= 0) break;
      if (!isPlainTextPart(block)) return false;
      const prefix = block.text.slice(0, chars);
      if (/\S/.test(prefix)) return false;
      chars -= prefix.length;
    }
  }
  return true;
}
