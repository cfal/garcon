import { describe, expect, it } from 'bun:test';
import { garconCommandResultContent, parseGarconCommandResult, parseAgentCommandOutcome } from '../garcon-command-results.ts';
import { parseTranscriptNoticeDetail } from '../transcript-notice-details.ts';

const correlation = { requestViewId: '00000000-0000-4000-8000-000000000001', requestOrdinal: 42 };
const start = { type: 'agent-start-outcome', ref: 'task', async: false, ...correlation };
const schedule = { type: 'agent-schedule-outcome', ...correlation };
const success = { ...schedule, status: 'created', scheduleId: '00000000-0000-4000-8000-000000000002',
  nextRunAt: '2030-01-01T12:00:00.000Z', intervalMinutes: 5, endAtUtc: null, busyBehavior: 'queue' };

describe('agent command outcomes', () => {
  it.each([
    { ...start, status: 'accepted', chatId: '1000000000000000' },
    { ...start, status: 'rejected', reason: 'unsupported-permission-mode' },
    { ...start, status: 'preamble-rejected', reason: 'slash-command-blocked', chatId: '1000000000000000' },
    { ...start, status: 'outcome-unknown' },
    { ...start, status: 'outcome-unknown', chatId: '1000000000000000' },
    success, { ...success, intervalMinutes: null }, { ...success, endAtUtc: success.nextRunAt },
    { ...schedule, status: 'failed', reason: 'limit-reached' },
    { ...schedule, status: 'outcome-unknown', scheduleId: success.scheduleId },
  ])('round-trips exact public notices and standalone result envelopes: %j', (detail) => {
    expect(parseTranscriptNoticeDetail(detail)).toEqual(detail);
    expect(parseGarconCommandResult(garconCommandResultContent(detail))).toEqual(detail);
    expect(garconCommandResultContent(detail)).toContain('request-view-id="00000000-0000-4000-8000-000000000001" request-ordinal="42"');
  });

  it('rejects invalid combinations, missing correlation, and private evidence', () => {
    for (const detail of [
      { ...start, status: 'accepted' }, { ...start, status: 'accepted', chatId: 'bad' },
      { ...start, status: 'rejected', reason: 'limit-reached' },
      { ...start, status: 'preamble-rejected', reason: 'composition-invalid' },
      { ...start, status: 'accepted', reason: 'action-failed', chatId: '1000000000000000' },
      { ...success, requestOrdinal: 0 }, { ...success, requestOrdinal: Number.MAX_SAFE_INTEGER + 1 },
      { ...success, requestViewId: '' }, { ...success, requestViewId: undefined },
      { ...success, intervalMinutes: 1.5 }, { ...success, busyBehavior: 'steer' },
      { ...success, intervalMinutes: null, endAtUtc: success.nextRunAt },
      { ...success, endAtUtc: '2029-01-01T00:00:00.000Z' },
      { ...success, nativeResultInput: true }, { ...success, title: 'private' },
    ]) expect(parseAgentCommandOutcome(detail)).toBeNull();
    const envelope = garconCommandResultContent(success);
    for (const content of [`prefix ${envelope}`, `${envelope} suffix`, envelope.replace('42', '0'),
      envelope.replace(' />', ' native-result-input="true" />'), envelope.replace('status="created"', 'status="created" status="failed"')]) {
      expect(parseGarconCommandResult(content)).toBeNull();
    }
  });
});
