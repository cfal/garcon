import { expect, mock, test } from 'bun:test';
import { GUARDED_AUTOMATION_POLICY } from '../../../../common/automation.js';
import { parseTranscriptNoticeDetail } from '../../../../common/transcript-notice-details.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { AgentCommandComposition } from '../agent-command-composition.js';
import { denyInBandCommand } from '../in-band-command-policy.js';

const source = { chatId: '1000000000000001', viewId: '00000000-0000-4000-8000-000000000001',
  at: '2026-01-01T00:00:00.000Z', runId: 'synthetic-run', requestOrdinal: 1 };

test('guarded workers cannot allocate orchestration or start denial reply turns', () => {
  const forbidden = mock(() => { throw new Error('Guarded command reached an effect'); });
  const notices = { appendNotice: mock(() => undefined) };
  const composition = new AgentCommandComposition();
  composition.initialize({
    registry: { getChat: () => ({ automationPolicy: GUARDED_AUTOMATION_POLICY }) },
    notices, adoption: { ensure: forbidden }, chatMutationLock: new KeyedPromiseLock(),
    execution: { queueServerControlInput: forbidden, deliverServerControlInput: forbidden, offerServerControlInput: forbidden },
    settings: { getFeatureSettings: forbidden }, selection: { resolve: forbidden },
    commands: {}, turns: { waitForTurnTerminal: forbidden }, chatIds: { allocate: forbidden },
    scheduler: {}, tickets: {}, resolveProject: forbidden,
  });
  try {
    for (const sink of [composition.agentStarts, composition.agentResumes, composition.agentStops,
      composition.agentSchedules, composition.ticketCommands]) sink.request(source, {});
    composition.chatIdRequests.request(source);
    composition.commandRejections.reject({ ...source, noticeOrdinal: 1 }, [{ command: 'start-agent', reason: 'malformed', edge: 'leading' }]);
    composition.interAgentMessages.request({ sourceChatId: source.chatId, sourceViewId: source.viewId,
      requestAt: source.at, recipients: ['1000000000000002'], hideSender: false, body: 'Synthetic request' });
    expect(forbidden).not.toHaveBeenCalled();
    expect(notices.appendNotice).toHaveBeenCalledTimes(8);
    for (const [chatId, viewId, notice] of notices.appendNotice.mock.calls) {
      expect({ chatId, viewId }).toEqual({ chatId: source.chatId, viewId: source.viewId });
      expect(parseTranscriptNoticeDetail(JSON.parse(JSON.stringify(notice.detail))))
        .toEqual({ type: 'in-band-command-denied' });
    }
  } finally { composition.shutdown(); }
});

test.each([undefined, { inBandCommands: 'inherit' }])('ordinary command defaults remain enabled: %j', automationPolicy => {
  const notices = { appendNotice: mock(() => undefined) };
  expect(denyInBandCommand(source, { getChat: () => ({ automationPolicy }) }, notices)).toBe(false);
  expect(notices.appendNotice).not.toHaveBeenCalled();
});
