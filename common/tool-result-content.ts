import { isRecord } from './json.js';

export function toolResultTextPart(block: unknown): (Record<string, unknown> & { text: string }) | null {
  const part = isRecord(block) && block.type === 'content' ? block.content : block;
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ? part as Record<string, unknown> & { text: string } : null;
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
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return false;
      for (const field in block) {
        if (Object.hasOwn(block, field) && field !== 'type' && field !== 'text') return false;
      }
      const prefix = block.text.slice(0, chars);
      if (/\S/.test(prefix)) return false;
      chars -= prefix.length;
    }
  }
  return true;
}
