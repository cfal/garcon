import type { TranscriptPage, TranscriptReadPurpose } from '../../common/chat-view.js';
import type { IssueSource } from '../../common/issues.js';
import type { IssueSourceResolution } from '../../common/issue-source-navigation.js';

export interface IssueSourceReader {
  resolveIssueSource(source: IssueSource, signal?: AbortSignal): Promise<IssueSourceResolution>;
}

export interface TranscriptPageReader {
  page(
    chatId: string,
    limit: number,
    beforeOrdinal?: number,
    expectedTranscriptViewId?: string,
    signal?: AbortSignal,
    purpose?: TranscriptReadPurpose,
  ): Promise<TranscriptPage>;
}
