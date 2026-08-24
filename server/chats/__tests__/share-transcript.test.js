import { describe, expect, it } from 'bun:test';
import {
  CliRowMessage,
  ErrorMessage,
  parseChatMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { renderSharedChatText } from '../share-transcript.ts';

const AT = '2026-08-18T12:00:00.000Z';

describe('shared transcript chat rows', () => {
  it('[TLV5-CHAT-ROW.07-SHARE-UNIT-01] formats notice and error rows without losing content', () => {
    const legacyNotice = parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Legacy shared notice.',
      detail: { type: 'cli-row' },
    });
    const legacyError = parseChatMessage({
      type: 'error',
      timestamp: AT,
      content: 'Legacy shared error.',
      detail: { type: 'cli-row' },
    });
    expect(legacyNotice).toBeInstanceOf(CliRowMessage);
    expect(legacyError).toBeInstanceOf(CliRowMessage);
    if (!legacyNotice || !legacyError) throw new Error('Legacy CLI rows did not parse.');

    const rendered = renderSharedChatText({
      shareToken: 'synthetic-share-token',
      chatId: 'synthetic-chat',
      title: 'Synthetic chat rows',
      agentId: 'direct-openai-compatible',
      model: 'synthetic-model',
      projectPath: '/synthetic/workspace',
      sharedAt: AT,
      messages: [
        new CliRowMessage(
          AT,
          'Shared information.',
          { style: 'info' },
          'markdown',
          'Consultation status',
        ),
        new CliRowMessage(
          AT,
          'Shared notice.\nSecond line.',
          { style: 'notice' },
          'plain',
          'Deployment',
        ),
        new CliRowMessage(AT, 'Shared error.', { style: 'error' }, 'plain'),
        new CliRowMessage(
          AT,
          '**Shared custom.**',
          {
            style: 'custom',
            customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
          },
          'markdown',
          'Custom deployment',
        ),
        legacyNotice,
        legacyError,
        new TranscriptNoticeMessage(AT, 'Internal notice.'),
        new ErrorMessage(AT, 'Provider error.'),
      ],
    });

    expect(rendered).toContain(`[CLI Info — Consultation status] ${AT}\nShared information.`);
    expect(rendered).toContain(`[CLI Notice — Deployment] ${AT}\nShared notice.\nSecond line.`);
    expect(rendered).toContain(`[CLI Error] ${AT}\nShared error.`);
    expect(rendered).toContain(`[CLI Custom — Custom deployment] ${AT}\n**Shared custom.**`);
    expect(rendered).toContain(`[CLI Notice] ${AT}\nLegacy shared notice.`);
    expect(rendered).toContain(`[CLI Error] ${AT}\nLegacy shared error.`);
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
        new UserMessage(AT, 'Context', undefined, undefined, {
          origin: 'cli', style: 'info', title: 'Consultation status',
        }),
        new UserMessage(AT, 'Body', undefined, undefined, {
          origin: 'cli', style: 'notice', title: 'Operator context',
        }),
        new UserMessage(AT, 'Stop', undefined, undefined, {
          origin: 'cli', style: 'error',
        }),
        new UserMessage(AT, 'Collapsed body', undefined, undefined, {
          origin: 'cli', disclosure: 'collapsed',
        }),
      ],
    });

    expect(rendered).toContain(`[User (CLI Info) — Consultation status] ${AT}\nContext`);
    expect(rendered).toContain(`[User (CLI Notice) — Operator context] ${AT}\nBody`);
    expect(rendered).toContain(`[User (CLI Error)] ${AT}\nStop`);
    expect(rendered).toContain(`[User (CLI)] ${AT}\nCollapsed body`);
    expect(rendered).not.toContain('CLI Undefined');
  });
});
