import { describe, expect, it } from 'bun:test';
import {
  ErrorMessage,
  TranscriptNoticeMessage,
} from '../../../common/chat-types.ts';
import { renderSharedChatText } from '../share-transcript.ts';

const AT = '2026-08-18T12:00:00.000Z';

describe('shared transcript chat rows', () => {
  it('[TLV5-CHAT-ROW.07-SHARE-UNIT-01] formats notice and error rows without losing content', () => {
    const rendered = renderSharedChatText({
      shareToken: 'synthetic-share-token',
      chatId: 'synthetic-chat',
      title: 'Synthetic chat rows',
      agentId: 'direct-openai-compatible',
      model: 'synthetic-model',
      projectPath: '/synthetic/workspace',
      sharedAt: AT,
      messages: [
        new TranscriptNoticeMessage(
          AT,
          'Shared notice.\nSecond line.',
          { type: 'cli-row', title: 'Deployment' },
        ),
        new ErrorMessage(AT, 'Shared error.', { type: 'cli-row' }),
        new TranscriptNoticeMessage(AT, 'Internal notice.'),
        new ErrorMessage(AT, 'Provider error.'),
      ],
    });

    expect(rendered).toContain(`[CLI Notice — Deployment] ${AT}\nShared notice.\nSecond line.`);
    expect(rendered).toContain(`[CLI Error] ${AT}\nShared error.`);
    expect(rendered).toContain(`[Notice] ${AT}\nInternal notice.`);
    expect(rendered).toContain(`[Error] ${AT}\nProvider error.`);
  });
});
