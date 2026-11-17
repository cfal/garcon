import { parseChatId } from './chat-id.js';
import { isRecord } from './json.js';

export interface ChatLineage {
  readonly sourceChatId: string;
  readonly kind: 'fork' | 'handoff';
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

export function chatLineagesEqual(left: ChatLineage | null, right: ChatLineage | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.sourceChatId === right.sourceChatId
    && left.kind === right.kind
    && left.transcriptViewId === right.transcriptViewId
    && left.ordinal === right.ordinal;
}

export function parseChatLineage(value: unknown): ChatLineage | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['sourceChatId', 'kind', 'transcriptViewId', 'ordinal'].includes(key))) return null;

  let sourceChatId: string;
  try {
    sourceChatId = parseChatId(value.sourceChatId);
  } catch {
    return null;
  }

  const { kind } = value;
  if (kind !== 'fork' && kind !== 'handoff') return null;

  const { transcriptViewId, ordinal } = value;
  if (typeof transcriptViewId !== 'string' || transcriptViewId.length === 0) {
    return null;
  }
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) return null;

  return Object.freeze({
    sourceChatId,
    kind,
    transcriptViewId,
    ordinal,
  });
}
