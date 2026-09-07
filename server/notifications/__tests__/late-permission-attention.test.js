import { expect, it, mock } from 'bun:test';

import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { AttentionTracker } from '../attention-tracker.ts';

const AT = '2026-08-16T00:00:00.000Z';
const CHAT_ID = 'chat-1';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';

it('[TLV5-PERM.11-NOTIFIER-UNIT-01] ignores late inert permission history without suppressing idle attention', async () => {
  let onTranscriptCommitted;
  let onChatIdle;
  let resolveNotification;
  const notification = new Promise((resolve) => {
    resolveNotification = resolve;
  });
  const getUiSettings = mock(async () => ({
    notifications: { telegram: { enabled: true } },
  }));
  const send = mock(async (...args) => {
    resolveNotification(args);
    return true;
  });

  new AttentionTracker(
    { onTranscriptCommitted: (callback) => { onTranscriptCommitted = callback; } },
    {
      onChatIdle: (callback) => { onChatIdle = callback; },
      onSessionStopped: () => {},
    },
    {
      getUiSettings,
      getChatName: () => null,
    },
    {
      getChat: () => ({ agentId: 'test', projectPath: '/workspace' }),
    },
    { getMessages: () => [] },
    { isConfigured: true, send },
    { getRecipientChatId: () => 'recipient-1' },
  );

  onTranscriptCommitted(runEndedCommit());
  onTranscriptCommitted(latePermissionCommit());

  expect(getUiSettings).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  onChatIdle(CHAT_ID);
  const [, html, parseMode] = await notification;

  expect(send).toHaveBeenCalledTimes(1);
  expect(parseMode).toBe('HTML');
  expect(html).not.toContain('Needs permission');
});

function runEndedCommit() {
  return {
    type: 'run-ended',
    chatId: CHAT_ID,
    viewId: 'view-1',
    runId: 'run-1',
    row: {
      kind: 'run-ended',
      ordinal: 1,
      at: AT,
      providerMeta: null,
      origin: 'provider',
      outcome: 'finished',
    },
  };
}

function latePermissionCommit() {
  return {
    type: 'permission',
    chatId: CHAT_ID,
    viewId: 'view-1',
    runId: null,
    row: {
      kind: 'permission-requested',
      ordinal: 2,
      at: AT,
      providerMeta: null,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: OCCURRENCE_ID,
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
        options: [],
      },
    },
  };
}
