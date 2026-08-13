import {
  UserMessage,
  type ChatImage,
} from '../../common/chat-types.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import type {
  PendingInputsPort,
  PendingUserInputRegistrationOptions,
} from './types.ts';

export interface AcceptedInputProjectionHandle {
  readonly inserted: boolean;
}

export interface AcceptedInputProjectionPort {
  admitInput(
    chatId: string,
    message: UserMessage,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
  ): Promise<AcceptedInputProjectionHandle>;
}

export class AcceptedInputTranscript {
  constructor(
    private readonly pendingInputs: PendingInputsPort,
    private readonly projection: AcceptedInputProjectionPort,
  ) {}

  async register(
    chatId: string,
    content: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<boolean> {
    if (!content && !options.images?.length) return true;
    const deliveryStatus = options.deliveryStatus ?? 'accepted';
    const images = normalizeChatImages(options.images);
    let clientRequestId: string | undefined;
    try {
      const registered = await this.pendingInputs.register(chatId, content, {
        clientRequestId: options.clientRequestId,
        clientMessageId: options.clientMessageId,
        turnId: options.turnId,
        images,
        deliveryStatus,
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      });
      const record = registered && typeof registered === 'object'
        ? registered as { clientRequestId?: unknown; createdAt?: unknown }
        : null;
      clientRequestId = typeof record?.clientRequestId === 'string'
        ? record.clientRequestId
        : options.clientRequestId;
      if (!clientRequestId) throw new TypeError('Accepted input is missing a client request ID');
      // Admission is idempotent by identity, so a dispatch retry must rebuild
      // the exact registered message; a fresh timestamp would be a typed
      // payload conflict.
      const createdAt = options.createdAt
        ?? (typeof record?.createdAt === 'string' ? record.createdAt : new Date().toISOString());
      const handle = await this.projection.admitInput(
        chatId,
        new UserMessage(createdAt, content, images),
        { ...options, clientRequestId },
      );
      this.pendingInputs.settleCommitted(chatId, clientRequestId);
      return handle.inserted !== false;
    } catch (error) {
      if (clientRequestId) this.pendingInputs.discard(chatId, clientRequestId);
      throw error;
    }
  }

}

function normalizeChatImages(images: RunAgentTurnOptions['images']): ChatImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image, index) => ({
    data: image.data,
    name: image.name || `image-${index + 1}`,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
  }));
}
