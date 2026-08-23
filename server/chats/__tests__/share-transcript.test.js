import { describe, expect, it } from 'bun:test';
import {
  ErrorMessage,
  TranscriptNoticeMessage,
  UserMessage,
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
            { type: 'cli-row', style: 'notice' },
          'Deployment',
        ),
          new ErrorMessage(AT, 'Shared error.', { type: 'cli-row', style: 'error' }),
        new TranscriptNoticeMessage(AT, 'Internal notice.'),
        new ErrorMessage(AT, 'Provider error.'),
      ],
    });

    expect(rendered).toContain(`[CLI Notice — Deployment] ${AT}\nShared notice.\nSecond line.`);
    expect(rendered).toContain(`[CLI Error] ${AT}\nShared error.`);
    expect(rendered).toContain(`[Notice] ${AT}\nInternal notice.`);
    expect(rendered).toContain(`[Error] ${AT}\nProvider error.`);
  });

  it('distinguishes presented user messages from presentation-only CLI rows', () => {
    const rendered = renderSharedChatText({
      shareToken: 'synthetic-share-token',
      chatId: 'synthetic-chat',
      title: 'Presented users',
      agentId: 'codex',
      model: 'gpt',
      projectPath: '/synthetic/workspace',
      sharedAt: AT,
      messages: [
        new UserMessage(AT, 'Body', undefined, undefined, {
          origin: 'cli', style: 'notice', title: 'Operator context',
        }),
        new UserMessage(AT, 'Stop', undefined, undefined, {
          origin: 'cli', style: 'error',
        }),
      ],
    });

    expect(rendered).toContain(`[User (CLI Notice) — Operator context] ${AT}\nBody`);
    expect(rendered).toContain(`[User (CLI Error)] ${AT}\nStop`);
  });
});
