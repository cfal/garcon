import {
  UserMessage,
  type ChatImage,
} from '../../common/chat-types.ts';
import type { ChatViewMessage } from '../../common/chat-view.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import { createLogger } from '../lib/log.ts';
import type {
  ChatMessagesPort,
  PendingInputsPort,
  PendingUserInputRegistrationOptions,
} from './types.ts';

const logger = createLogger('accepted-input-transcript');

export interface AcceptedInputTranscriptEvents {
  appended(
    chatId: string,
    generationId: string,
    messages: ChatViewMessage[],
    metadata: { clientRequestId?: string; turnId?: string },
  ): void;
}

export class AcceptedInputTranscript {
  constructor(
    private readonly pendingInputs: PendingInputsPort,
    private readonly chatMessages: ChatMessagesPort,
    private readonly events: AcceptedInputTranscriptEvents,
  ) {}

  async register(
    chatId: string,
    content: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void> {
    if (!content && !options.images?.length) return;
    const deliveryStatus = options.deliveryStatus ?? 'accepted';
    const images = normalizeChatImages(options.images);
    let clientRequestId: string | undefined;
    let appended: { generationId: string; messages: ChatViewMessage[] };
    try {
      const registered = await this.pendingInputs.register(chatId, content, {
        clientRequestId: options.clientRequestId,
        clientMessageId: options.clientMessageId,
        turnId: options.turnId,
        images,
        deliveryStatus,
      });
      const record = registered && typeof registered === 'object'
        ? registered as { clientRequestId?: unknown }
        : null;
      clientRequestId = typeof record?.clientRequestId === 'string'
        ? record.clientRequestId
        : options.clientRequestId;
      appended = await this.chatMessages.appendMessages(chatId, [
        new UserMessage(new Date().toISOString(), content, images, {
          clientRequestId,
          turnId: options.turnId,
          deliveryStatus,
        }),
      ]);
    } catch (error) {
      if (clientRequestId) this.pendingInputs.discard(chatId, clientRequestId);
      throw error;
    }
    if (appended.messages.length === 0) return;
    try {
      this.events.appended(chatId, appended.generationId, appended.messages, {
        clientRequestId,
        turnId: options.turnId,
      });
    } catch (error) {
      logger.warn('chat-messages listener failed after durable append:', (error as Error).message);
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
