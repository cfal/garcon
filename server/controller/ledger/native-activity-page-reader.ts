import type { TranscriptPage, TranscriptReadPurpose } from '../../../common/chat-view.js';
import type { TranscriptAnchorPageReader, TranscriptAnchorRead, TranscriptPageReader } from '../chats/chat-message-reader.js';
import type { TranscriptAnchorRequest } from '../../../common/transcript-anchor-page.js';
import type { NativeTranscriptActivityService } from './native-activity.js';

export class NativeActivityPageReader implements TranscriptPageReader {
  constructor(
    private readonly pages: TranscriptPageReader,
    private readonly nativeActivity: Pick<NativeTranscriptActivityService, 'requestCheck'>,
  ) {}

  page(
    chatId: string,
    limit: number,
    beforeOrdinal?: number,
    expectedTranscriptViewId?: string,
    signal?: AbortSignal,
    purpose?: TranscriptReadPurpose,
  ): Promise<TranscriptPage> {
    const page = this.pages.page(
      chatId,
      limit,
      beforeOrdinal,
      expectedTranscriptViewId,
      signal,
    );
    if (purpose === 'activation' && beforeOrdinal === undefined) {
      void page.then(() => {
        queueMicrotask(() => this.nativeActivity.requestCheck(chatId, 'activation'));
      }, () => undefined);
    }
    return page;
  }
}

export class NativeActivityAnchorPageReader implements TranscriptAnchorPageReader {
  constructor(
    private readonly pages: TranscriptAnchorPageReader,
    private readonly nativeActivity: Pick<NativeTranscriptActivityService, 'requestCheck'>,
  ) {}

  anchorPage(request: TranscriptAnchorRequest, signal?: AbortSignal): Promise<TranscriptAnchorRead> {
    const page = this.pages.anchorPage(request, signal);
    if (request.purpose === 'activation' && request.direction === 'backward'
      && request.cursorOrdinal === undefined && request.watermarkOrdinal === undefined) {
      void page.then(() => {
        queueMicrotask(() => this.nativeActivity.requestCheck(request.chatId, 'activation'));
      }, () => undefined);
    }
    return page;
  }
}
