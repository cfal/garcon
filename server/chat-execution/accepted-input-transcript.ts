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
  discardKnownNotSent(): Promise<void>;
}

export interface AcceptedInputProjectionPort {
  admitInput(
    chatId: string,
    message: UserMessage,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
  ): Promise<AcceptedInputProjectionHandle>;
}

export class AcceptedInputTranscript {
  readonly #handles = new Map<string, AcceptedInputProjectionHandle>();

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
        new UserMessage(createdAt, content, images, {
          clientRequestId,
          upstreamRequestId: options.clientMessageId,
          turnId: options.turnId,
          deliveryStatus,
        }),
        { ...options, clientRequestId },
      );
      if (handle.inserted !== false) {
        this.#handles.set(inputKey(chatId, clientRequestId), handle);
      } else {
        await handle.discardKnownNotSent();
        this.pendingInputs.discard(chatId, clientRequestId);
      }
      return handle.inserted !== false;
    } catch (error) {
      if (clientRequestId) this.pendingInputs.discard(chatId, clientRequestId);
      throw error;
    }
  }

  async discardKnownNotSent(chatId: string, clientRequestId: string): Promise<void> {
    const key = inputKey(chatId, clientRequestId);
    const handle = this.#handles.get(key);
    if (!handle) return;
    await handle.discardKnownNotSent();
    this.#handles.delete(key);
  }

  settle(chatId: string, clientRequestId: string): void {
    this.#handles.delete(inputKey(chatId, clientRequestId));
  }
}

function inputKey(chatId: string, clientRequestId: string): string {
  return JSON.stringify([chatId, clientRequestId]);
}

function normalizeChatImages(images: RunAgentTurnOptions['images']): ChatImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image, index) => ({
    data: image.data,
    name: image.name || `image-${index + 1}`,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
  }));
}
