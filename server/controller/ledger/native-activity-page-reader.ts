import type {
  TranscriptPage,
  TranscriptReadPurpose,
  TranscriptReplayResult,
} from '../../../common/chat-view.js';
import type { TranscriptPageReader } from '../chats/chat-message-reader.js';
import type { TranscriptViewId } from './contracts.js';
import type { NativeTranscriptActivityService } from './native-activity.js';
import type { TranscriptViewReader } from './view-reader.js';

type NativeActivityRequests = Pick<NativeTranscriptActivityService, 'requestCheck'>;

// Activation reads are the only production schedulers of the advisory native check, and
// each schedules it only after its read succeeds.
function scheduleAfterRead<T>(read: Promise<T>, chatId: string, nativeActivity: NativeActivityRequests): void {
  void read.then(() => {
    queueMicrotask(() => nativeActivity.requestCheck(chatId, 'activation'));
  }, () => undefined);
}

export class NativeActivityPageReader implements TranscriptPageReader {
  constructor(
    private readonly pages: TranscriptPageReader,
    private readonly nativeActivity: NativeActivityRequests,
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
      scheduleAfterRead(page, chatId, this.nativeActivity);
    }
    return page;
  }
}

// A warm activation catches a cached window up through replay instead of a newest page;
// only its first page carries the purpose, so continuations never schedule the check.
export class NativeActivityReplayReader {
  constructor(
    private readonly replays: Pick<TranscriptViewReader, 'replay'>,
    private readonly nativeActivity: NativeActivityRequests,
  ) {}

  replay(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    throughOrdinal?: number,
    purpose?: TranscriptReadPurpose,
  ): Promise<TranscriptReplayResult> {
    const replay = this.replays.replay(chatId, viewId, afterOrdinal, throughOrdinal);
    if (purpose === 'activation' && throughOrdinal === undefined) {
      scheduleAfterRead(replay, chatId, this.nativeActivity);
    }
    return replay;
  }
}
