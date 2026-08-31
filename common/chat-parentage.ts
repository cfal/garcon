import { parseChatId } from './chat-id.js';
import { isRecord } from './json.js';

export const CHAT_PARENT_RELATIONS = [
  'fork',
  'handoff',
  'delegation',
] as const;

export type ChatParentRelation = (typeof CHAT_PARENT_RELATIONS)[number];

interface ParentChatRefBase {
  readonly chatId: string;
}

export interface TranscriptParentChatRef extends ParentChatRefBase {
  readonly relation: 'fork' | 'handoff';
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

export interface DelegationParentChatRef extends ParentChatRefBase {
  readonly relation: 'delegation';
}

export type ParentChatRef = TranscriptParentChatRef | DelegationParentChatRef;

export function isChatParentRelation(value: unknown): value is ChatParentRelation {
  return typeof value === 'string'
    && (CHAT_PARENT_RELATIONS as readonly string[]).includes(value);
}

export function parseParentChatRef(value: unknown): ParentChatRef | null {
  if (!isRecord(value)) return null;

  let chatId: string;
  try {
    chatId = parseChatId(value.chatId);
  } catch {
    return null;
  }

  const { relation } = value;
  if (!isChatParentRelation(relation)) return null;
  if (relation === 'delegation') {
    return Object.freeze({ chatId, relation });
  }

  const { transcriptViewId, ordinal } = value;
  if (typeof transcriptViewId !== 'string' || transcriptViewId.length === 0) {
    return null;
  }
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) return null;

  return Object.freeze({
    chatId,
    relation,
    transcriptViewId,
    ordinal,
  });
}
