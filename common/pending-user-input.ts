import type { ChatImage, UserMessageDeliveryStatus } from './chat-types';

export interface PendingUserInputAttachment {
  name: string;
  mimeType?: string;
}

export interface PendingUserInput {
  chatId: string;
  clientRequestId: string;
  content: string;
  createdAt: string;
  deliveryStatus: UserMessageDeliveryStatus;
  clientMessageId?: string;
  turnId?: string;
  images?: ChatImage[];
  attachments?: PendingUserInputAttachment[];
}

export type PendingUserInputClearReason = 'chat-removed' | 'persisted';

function isChatImage(value: unknown): value is ChatImage {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.data === 'string'
    && typeof raw.name === 'string'
    && (raw.mimeType === undefined || typeof raw.mimeType === 'string');
}

function normalizeImages(value: unknown): ChatImage[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isChatImage)) return null;
  return value.length > 0 ? value : undefined;
}

function normalizeAttachments(value: unknown): PendingUserInputAttachment[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const attachments: PendingUserInputAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.name !== 'string'
      || !raw.name
      || (raw.mimeType !== undefined && typeof raw.mimeType !== 'string')
    ) {
      return null;
    }
    attachments.push({
      name: raw.name,
      ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
    });
  }
  return attachments.length > 0 ? attachments : undefined;
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
  if (images === null) return null;
  if (images) normalized.images = images;
  const attachments = normalizeAttachments(raw.attachments);
  if (attachments === null) return null;
  if (attachments) normalized.attachments = attachments;
  return normalized;
}
