import { describe, expect, it } from 'vitest';

import { formatSidebarChatTimestamp } from '../chat-timestamp.js';

describe('formatSidebarChatTimestamp', () => {
	it('uses a short month-day label for timestamps in the current year', () => {
		expect(
			formatSidebarChatTimestamp('2026-04-18T07:30:00.000Z', new Date('2026-04-19T08:00:00.000Z'))
		).toEqual({
			dateLabel: 'Apr 18',
			timeLabel: '7:30 AM',
			tooltip: 'Apr 18, 2026, 7:30 AM',
		});
	});

	it('falls back to a compact numeric date for older years', () => {
		expect(
			formatSidebarChatTimestamp('2025-12-31T23:45:00.000Z', new Date('2026-04-19T08:00:00.000Z'))
		).toEqual({
			dateLabel: '12/31/25',
			timeLabel: '11:45 PM',
			tooltip: 'Dec 31, 2025, 11:45 PM',
		});
	});

	it('returns null for missing or invalid timestamps', () => {
		expect(formatSidebarChatTimestamp(null, new Date('2026-04-19T08:00:00.000Z'))).toBeNull();
		expect(
			formatSidebarChatTimestamp('not-a-date', new Date('2026-04-19T08:00:00.000Z'))
		).toBeNull();
	});
});
