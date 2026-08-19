import type { TranscriptPage, TranscriptReadPurpose } from '../../common/chat-view.js';
import type { TranscriptPageReader } from '../chats/chat-message-reader.js';
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
