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

  if (!isChatParentRelation(value.relation)) return null;
  if (typeof value.transcriptViewId !== 'string' || value.transcriptViewId.length === 0) {
    return null;
  }
  if (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0) return null;

  return Object.freeze({
    chatId,
    relation: value.relation,
    transcriptViewId: value.transcriptViewId,
    ordinal: Number(value.ordinal),
  });
}
