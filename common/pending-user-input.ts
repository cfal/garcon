import type { ChatImage, UserMessageDeliveryStatus } from './chat-types';

export interface PendingUserInput {
  chatId: string;
  clientRequestId: string;
  content: string;
  createdAt: string;
  deliveryStatus: UserMessageDeliveryStatus;
  clientMessageId?: string;
  turnId?: string;
  images?: ChatImage[];
}

export type PendingUserInputClearReason = 'chat-removed';

function isChatImage(value: unknown): value is ChatImage {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.data === 'string' && typeof raw.name === 'string';
}

function normalizeImages(value: unknown): ChatImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value.filter(isChatImage);
  return images.length > 0 ? images : undefined;
}

export function normalizePendingUserInput(value: unknown): PendingUserInput | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const chatId = typeof raw.chatId === 'string' ? raw.chatId : null;
  const clientRequestId = typeof raw.clientRequestId === 'string' ? raw.clientRequestId : null;
  const content = typeof raw.content === 'string' ? raw.content : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : null;
  const deliveryStatus = raw.deliveryStatus === 'submitting'
    || raw.deliveryStatus === 'accepted'
    || raw.deliveryStatus === 'failed'
    ? raw.deliveryStatus
    : null;
  if (!chatId || !clientRequestId || content === null || !createdAt || !deliveryStatus) return null;
  const normalized: PendingUserInput = {
    chatId,
    clientRequestId,
    content,
    createdAt,
    deliveryStatus,
  };
  if (typeof raw.clientMessageId === 'string') normalized.clientMessageId = raw.clientMessageId;
  if (typeof raw.turnId === 'string') normalized.turnId = raw.turnId;
  const images = normalizeImages(raw.images);
  if (images) normalized.images = images;
  return normalized;
}
