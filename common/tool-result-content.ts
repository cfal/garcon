import { isRecord } from './json.js';
import { isTextPart, type ToolTextPart } from './tool-result-message.js';
export { toolResultTextPart } from './tool-result-message.js';

export function isPlainTextPart(part: unknown): part is ToolTextPart {
  if (!isTextPart(part)) return false;
  for (const key in part) {
    if (Object.hasOwn(part, key) && key !== 'type' && key !== 'text') return false;
  }
  return true;
}

export function plainToolResultTextPart(block: unknown): ToolTextPart | null {
  if (isPlainTextPart(block)) return block;
  if (!isRecord(block) || block.type !== 'content' || !isPlainTextPart(block.content)) return null;
  for (const key in block) {
    if (Object.hasOwn(block, key) && key !== 'type' && key !== 'content') return null;
  }
  return block.content;
}

// Search inspects only its indexed prefix; the transcript inspects the full body.
export function isEmptyToolResult(content: unknown, limits?: { maxChars: number; maxBlocks: number }): boolean {
  if (content == null) return true;
  if (!isRecord(content)) return false;
  const maxChars = limits?.maxChars ?? Infinity;
  let chars = maxChars;
  let blocks = limits?.maxBlocks ?? Infinity;
  for (const key in content) {
    if (!Object.hasOwn(content, key)) continue;
    if (key === 'raw' || key === 'rawOutput') {
      let value = content[key];
      if (key === 'rawOutput' && isRecord(value)) {
        for (const field in value) if (Object.hasOwn(value, field) && field !== 'output') return false;
        value = value.output;
      }
      if (typeof value !== 'string' || /\S/.test(value.slice(0, maxChars))) return false;
      continue;
    }
    if (key !== 'items' && key !== 'content') return false;
    const items = content[key];
    if (!Array.isArray(items)) return false;
    for (const block of items) {
      if (blocks-- <= 0) break;
      const part = plainToolResultTextPart(block);
      if (!part) return false;
      const prefix = part.text.slice(0, chars);
      if (/\S/.test(prefix)) return false;
      chars -= prefix.length;
    }
  }
  return true;
}
