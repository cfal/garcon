import {
  UserMessage,
  type ChatImage,
} from '../../common/chat-types.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import type {
  UserInputAdmissionOptions,
} from './types.ts';

export interface AcceptedInputTranscriptResult {
  readonly inserted: boolean;
}

export interface AcceptedInputTranscriptPort {
  admitInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions & { readonly clientRequestId: string },
  ): Promise<AcceptedInputTranscriptResult>;
  admitQueuedInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions & { readonly clientRequestId: string },
  ): AcceptedInputTranscriptResult;
  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void;
}

export class AcceptedInputTranscript {
  constructor(private readonly transcript: AcceptedInputTranscriptPort) {}

  async register(
    chatId: string,
    content: string,
    options: UserInputAdmissionOptions,
  ): Promise<boolean> {
    if (!content && !options.images?.length) return true;
    if (!options.clientRequestId) {
      throw new TypeError('Accepted input is missing a client request ID');
    }
    const images = normalizeChatImages(options.images);
    const result = await this.transcript.admitInput(
      chatId,
      new UserMessage(
        options.createdAt ?? new Date().toISOString(),
        content,
        images,
        undefined,
        options.userMessagePresentation,
      ),
      { ...options, clientRequestId: options.clientRequestId },
    );
    return result.inserted !== false;
  }

  registerQueued(
    chatId: string,
    content: string,
    options: UserInputAdmissionOptions,
  ): boolean {
    if (!content && !options.images?.length) return true;
    if (!options.clientRequestId) {
      throw new TypeError('Accepted input is missing a client request ID');
    }
    const images = normalizeChatImages(options.images);
    const result = this.transcript.admitQueuedInput(
      chatId,
      new UserMessage(options.createdAt ?? new Date().toISOString(), content, images),
      { ...options, clientRequestId: options.clientRequestId },
    );
    return result.inserted !== false;
  }

  discard(chatId: string, clientMessageId: string | null | undefined): void {
    this.transcript.discardPreparedInput(chatId, clientMessageId);
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
