import { describe, expect, it } from 'vitest';
import {
	formatDayLong,
	formatDayShort,
	formatDayWithYear,
	formatPercent,
	formatTokens,
	formatUsd,
	formatUsdAxis,
} from '../usage-format';

describe('usage formatting', () => {
	it('formats dollar amounts and keeps tiny costs visible', () => {
		expect(formatUsd(30_000.66)).toBe('$30,000.66');
		expect(formatUsd(0)).toBe('$0.00');
		expect(formatUsd(0.001)).toBe('<$0.01');
		expect(formatUsdAxis(3_000)).toBe('$3K');
		expect(formatUsdAxis(20)).toBe('$20');
		expect(formatUsdAxis(0.5)).toBe('$0.50');
		expect(formatUsdAxis(2.5)).toBe('$2.50');
		expect(formatUsdAxis(0.07)).toBe('$0.07');
	});

	it('abbreviates token counts', () => {
		expect(formatTokens(73_300_000_000)).toBe('73.3B');
		expect(formatTokens(713_000)).toBe('713K');
		expect(formatTokens(2_800_000_000)).toBe('2.8B');
		expect(formatTokens(94_500_000)).toBe('94.5M');
		expect(formatTokens(1_000)).toBe('1K');
		expect(formatTokens(999)).toBe('999');
	});

	it('formats shares and calendar days', () => {
		expect(formatPercent(0.669)).toBe('66.9%');
		expect(formatPercent(0.00001)).toBe('<0.1%');
		expect(formatDayShort('2026-10-07')).toBe('Oct 7');
		expect(formatDayLong('2026-10-07')).toBe('Wed, Oct 7');
		expect(formatDayWithYear('2026-10-07')).toBe('Oct 7, 2026');
		expect(formatDayShort('not-a-day')).toBe('not-a-day');
	});
});
