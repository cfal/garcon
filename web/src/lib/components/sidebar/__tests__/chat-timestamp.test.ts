import { describe, expect, it } from 'vitest';

import { formatSidebarChatTimestamp } from '../chat-timestamp.js';

describe('formatSidebarChatTimestamp', () => {
	it('uses compact relative hour labels', () => {
		expect(
			formatSidebarChatTimestamp(
				'2026-04-19T05:00:00.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: '3h ago',
			tooltip: 'Apr 19, 2026, 5:00 AM',
		});
	});

	it('uses compact relative minute labels', () => {
		expect(
			formatSidebarChatTimestamp(
				'2026-04-19T08:18:00.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: '12m ago',
			tooltip: 'Apr 19, 2026, 8:18 AM',
		});
	});

	it('uses now for timestamps less than one minute old', () => {
		expect(
			formatSidebarChatTimestamp(
				'2026-04-19T08:29:30.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: 'now',
			tooltip: 'Apr 19, 2026, 8:29 AM',
		});
	});

	it('uses compact relative day labels', () => {
		expect(
			formatSidebarChatTimestamp(
				'2026-04-17T08:30:00.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: '2d ago',
			tooltip: 'Apr 17, 2026, 8:30 AM',
		});
	});

	it('uses compact relative month labels for older chats', () => {
		expect(
			formatSidebarChatTimestamp(
				'2026-02-18T08:30:00.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: '2mo ago',
			tooltip: 'Feb 18, 2026, 8:30 AM',
		});
	});

	it('uses compact relative year labels for old chats', () => {
		expect(
			formatSidebarChatTimestamp(
				'2025-04-19T08:30:00.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: '1y ago',
			tooltip: 'Apr 19, 2025, 8:30 AM',
		});
	});

	it('preserves future direction when clock skew is large enough to matter', () => {
		expect(
			formatSidebarChatTimestamp(
				'2026-04-19T08:35:00.000Z',
				new Date('2026-04-19T08:30:00.000Z')
			)
		).toEqual({
			label: 'in 5m',
			tooltip: 'Apr 19, 2026, 8:35 AM',
		});
	});

	it('returns null for missing or invalid timestamps', () => {
		expect(formatSidebarChatTimestamp(null, new Date('2026-04-19T08:00:00.000Z'))).toBeNull();
		expect(
			formatSidebarChatTimestamp('not-a-date', new Date('2026-04-19T08:00:00.000Z'))
		).toBeNull();
	});
});
