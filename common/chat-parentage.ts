import { parseChatId } from './chat-id.js';
import { isRecord } from './json.js';

export const CHAT_PARENT_RELATIONS = [
  'fork',
  'handoff',
] as const;

export type ChatParentRelation = (typeof CHAT_PARENT_RELATIONS)[number];

export interface ParentChatRef {
  readonly chatId: string;
  readonly relation: ChatParentRelation;
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

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

  const { relation, transcriptViewId, ordinal } = value;
  if (!isChatParentRelation(relation)) return null;
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
