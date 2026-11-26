import { str } from './chat-message-coercion.js';
import { isRecord } from './json.js';

export interface ToolTextPart extends Record<string, unknown> {
  type: 'text';
  text: string;
}

export function isTextPart(part: unknown): part is ToolTextPart {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}

export function toolResultTextPart(block: unknown): ToolTextPart | null {
  const part = isRecord(block) && block.type === 'content' ? block.content : block;
  return isTextPart(part) ? part : null;
}

function parsePrimaryTextItems(refs: unknown, items: unknown): number[] | undefined {
  if (!Array.isArray(refs) || !Array.isArray(items) || !refs.length || refs.length > items.length) return undefined;
  const valid = refs.every((index, i) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) return false;
    return (i === 0 || index > refs[i - 1]) && toolResultTextPart(items[index]) !== null;
  });
  return valid ? refs : undefined;
}

export class ToolResultMessage {
  readonly type = 'tool-result' as const;

  constructor(
    public timestamp: string,
    public toolId: string,
    public content: Record<string, unknown>,
    public isError: boolean,
    // Ordered indices into content.items when those blocks also carry the primary output.
    public primaryTextItems?: readonly number[],
  ) {}

  static fromData(data: Record<string, unknown>): ToolResultMessage {
    const content = (data.content ?? {}) as Record<string, unknown>;
    return new ToolResultMessage(str(data.timestamp), str(data.toolId), content, Boolean(data.isError),
      parsePrimaryTextItems(data.primaryTextItems, content.items));
  }
}
