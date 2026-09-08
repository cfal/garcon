import { describe, expect, it } from 'bun:test';
import { garconScheduleActionContent, parseGarconSchedule, parseGarconScheduleAction, parseGarconScheduleInstant } from '../garcon-schedule.ts';
import { parseScheduleDuration, parseScheduleInterval } from '../schedule-duration.ts';

describe('same-chat schedule grammar', () => {
  it.each(['1m', '59m', '60m', '90m', '1h30m', '1d', '366d', '3650d'])('accepts recurring %s with a distinct default first-run form', (every) => {
    const parsed = parseGarconSchedule(`<garcon-schedule every="${every}" />`);
    expect(parsed).toMatchObject({
      type: 'schedule', firstRun: { type: 'after-interval' },
      intervalMinutes: parseScheduleInterval(every).minutes, busyBehavior: 'queue', endAtUtc: null, body: '',
    });
  });

  it('supports explicit first runs, offset instants, and inclusive ends', () => {
    expect(parseGarconSchedule('<garcon-schedule in="1h30m" every="5m" busy="skip">Check &amp; report.</garcon-schedule>'))
      .toMatchObject({ firstRun: { type: 'after', minutes: 90 }, intervalMinutes: 5, busyBehavior: 'skip', body: 'Check & report.' });
    expect(parseGarconSchedule('<garcon-schedule at="2030-01-02T09:00:00+02:00" every="1m" until="2030-01-02T07:00:00Z" />'))
      .toMatchObject({ firstRun: { type: 'at', atUtc: '2030-01-02T07:00:00.000Z' }, endAtUtc: '2030-01-02T07:00:00.000Z' });
    expect(parseGarconSchedule('<garcon-schedule in="365d" />')?.intervalMinutes).toBeNull();
  });

  it.each(['', 'in="1m" at="2030-01-02T07:00:00Z"', 'in="366d"', 'every="3650d1m"',
    'every="1.5h"', 'every="1s"', 'every="1m1h"', 'every="-1h"', 'every="0m"',
    'every="1h 1m"', 'every="9007199254740992m"', 'in="1m" until="2030-01-02T07:00:00Z"',
    'in="1m" busy="steer"', 'in="1m" chat-id="1000000000000000"', 'in="1m" model="example"',
    'in="1m" project-path="/project"', 'in="1m" in="2m"',
  ])('rejects invalid attributes: %s', (attributes) => {
    expect(parseGarconSchedule(`<garcon-schedule ${attributes} />`)).toBeNull();
  });

  it('retains distinct delay and recurrence bounds', () => {
    expect(parseScheduleDuration('366d')).toEqual({ ok: false, error: 'too-long' });
    expect(parseScheduleInterval('366d')).toEqual({ ok: true, minutes: 366 * 1440 });
  });

  it.each(['2030-02-29T00:00:00Z', '2030-02-30T00:00:00Z', '2030-13-01T00:00:00Z',
    '2030-01-01T24:00:00Z', '2030-01-01T00:60:00Z', '2030-01-01T00:00:01Z',
    '2030-01-01T00:00:00.001Z', '2030-01-01T00:00:00', '2030-01-01T00:00:00+24:00',
    '2030-01-01T00:00:00+01:60'])('rejects invalid absolute instant %s', (value) => {
    expect(parseGarconScheduleInstant(value)).toBeNull();
  });

  it('keeps escaped tags literal and frames empty and nonempty actions exactly', () => {
    for (const command of ['<garcon-schedule in="1m" />', '<garcon-schedule in="1m"></garcon-schedule>',
      '<garcon-schedule in="1m"> \n </garcon-schedule>']) {
      expect(garconScheduleActionContent(parseGarconSchedule(command).body)).toBe('<garcon-schedule-action />');
    }
    const body = 'A & B < C\n</garcon-schedule-action>\n&amp;lt;';
    const action = garconScheduleActionContent(body);
    expect(action).toBe('<garcon-schedule-action>\nA &amp; B &lt; C\n&lt;/garcon-schedule-action&gt;\n&amp;amp;lt;\n</garcon-schedule-action>');
    expect(parseGarconScheduleAction(action)).toEqual({ body });
    expect(parseGarconScheduleAction('<garcon-schedule-action />')).toEqual({ body: '' });
    expect(parseGarconScheduleAction('<garcon-schedule-action><nested /></garcon-schedule-action>')).toBeNull();
    expect(parseGarconScheduleAction(`prefix ${action}`)).toBeNull();
    expect(parseGarconSchedule('<garcon-schedule in="1m">&lt;garcon-get-chat-id /&gt;</garcon-schedule>')?.body)
      .toBe('<garcon-get-chat-id />');
  });

  it('includes framing, escaping and template expansion in the saved prompt limit', () => {
    const overhead = garconScheduleActionContent('x').length - 1;
    const exact = 'x'.repeat(32000 - overhead);
    expect(parseGarconSchedule(`<garcon-schedule in="1m">${exact}</garcon-schedule>`)).not.toBeNull();
    expect(parseGarconSchedule(`<garcon-schedule in="1m">${exact}x</garcon-schedule>`)).toBeNull();
    const tokens = `${'x'.repeat(32000 - overhead - 11)}{{chat_id}}`;
    expect(parseGarconSchedule(`<garcon-schedule in="1m">${tokens}</garcon-schedule>`)).toBeNull();
    expect(parseGarconSchedule(`<garcon-schedule in="1m">${'&lt;'.repeat(9000)}</garcon-schedule>`)).toBeNull();
  });
});
