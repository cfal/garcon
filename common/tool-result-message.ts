import { str } from './chat-message-coercion.js';
import { toolResultTextPart } from './tool-result-content.js';

function parsePrimaryTextItems(refs: unknown, items: unknown): number[] | undefined {
  if (!Array.isArray(refs) || !Array.isArray(items) || !refs.length || refs.length > items.length) return undefined;
  const valid = refs.every((index, i) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) return false;
    if (i > 0 && index <= refs[i - 1]) return false;
    return toolResultTextPart(items[index]) !== null;
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
