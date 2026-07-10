import { describe, expect, it } from 'bun:test';
import {
  parseScheduleDuration,
  scheduleInRunAt,
} from '../../../common/schedule-duration.ts';

describe('schedule duration', () => {
  it('parses single and ordered compound units case-insensitively', () => {
    expect(parseScheduleDuration('1m')).toEqual({ ok: true, minutes: 1 });
    expect(parseScheduleDuration('3h')).toEqual({ ok: true, minutes: 180 });
    expect(parseScheduleDuration('1d')).toEqual({ ok: true, minutes: 1_440 });
    expect(parseScheduleDuration('2h30m')).toEqual({ ok: true, minutes: 150 });
    expect(parseScheduleDuration('1D4H15M')).toEqual({ ok: true, minutes: 1_695 });
  });

  it('accepts non-normalized components within the aggregate limit', () => {
    expect(parseScheduleDuration('90m')).toEqual({ ok: true, minutes: 90 });
    expect(parseScheduleDuration('25h')).toEqual({ ok: true, minutes: 1_500 });
    expect(parseScheduleDuration('1d24h')).toEqual({ ok: true, minutes: 2_880 });
    expect(parseScheduleDuration('1h0m')).toEqual({ ok: true, minutes: 60 });
  });

  it('classifies missing, sub-minute, malformed, and zero durations', () => {
    expect(parseScheduleDuration('')).toEqual({ ok: false, error: 'missing' });
    for (const value of ['1s', '30s', '500ms', '2m10s']) {
      expect(parseScheduleDuration(value)).toEqual({
        ok: false,
        error: 'sub-minute-unsupported',
      });
    }
    for (const value of ['1.5h', '1 h', '1w', '1m1m', '30m2h']) {
      expect(parseScheduleDuration(value)).toEqual({ ok: false, error: 'invalid-format' });
    }
    expect(parseScheduleDuration('0m')).toEqual({ ok: false, error: 'too-short' });
  });

  it('accepts 365 days and rejects larger or unsafe totals', () => {
    expect(parseScheduleDuration('365d')).toEqual({ ok: true, minutes: 525_600 });
    expect(parseScheduleDuration('8760h')).toEqual({ ok: true, minutes: 525_600 });
    expect(parseScheduleDuration('365d1m')).toEqual({ ok: false, error: 'too-long' });
    expect(parseScheduleDuration(`${Number.MAX_SAFE_INTEGER}d`)).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('rounds up without mutating the input date or firing early', () => {
    const exact = new Date('2026-07-10T12:00:00.000Z');
    const late = new Date('2026-07-10T12:00:45.000Z');
    expect(scheduleInRunAt(exact, 1)).toBe('2026-07-10T12:01:00.000Z');
    expect(scheduleInRunAt(late, 1)).toBe('2026-07-10T12:02:00.000Z');
    expect(late.toISOString()).toBe('2026-07-10T12:00:45.000Z');
  });
});
