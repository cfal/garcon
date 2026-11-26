import { str } from './chat-message-coercion.js';
import { toolResultTextPart } from './tool-result-content.js';

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
    const refs = data.primaryTextItems;
    const items = content.items;
    const valid = Array.isArray(refs) && Array.isArray(items) && refs.length > 0 && refs.length <= items.length
      && refs.every((n, i) => Number.isSafeInteger(n) && n >= 0 && n < items.length
        && (i === 0 || n > refs[i - 1]) && toolResultTextPart(items[n]) !== null);
    return new ToolResultMessage(str(data.timestamp), str(data.toolId), content, Boolean(data.isError), valid ? refs : undefined);
  }
}
