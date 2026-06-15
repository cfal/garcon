import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import LocalNoticeRow from '../rows/LocalNoticeRow.svelte';
import type { LocalNoticeRow as LocalNotice } from '$lib/chat/local-notice';

function notice(noticeType: LocalNotice['noticeType'], content: string): LocalNotice {
	return {
		kind: 'local-notice',
		id: `notice-${noticeType}`,
		noticeType,
		content,
		timestamp: '2026-06-15T00:00:00.000Z',
	};
}

describe('LocalNoticeRow', () => {
	it('renders progress notices as compact info event cards', () => {
		const { container } = render(LocalNoticeRow, {
			notice: notice('progress', 'Forking chat...'),
		});

		expect(screen.getByText('Forking chat...')).toBeTruthy();
		expect(container.querySelector('article')?.className).toContain('border-status-info-border');
	});

	it('renders interruption notices with warning event-card styling', () => {
		const { container } = render(LocalNoticeRow, {
			notice: notice('warning', 'Chat interrupted by user.'),
		});

		expect(screen.getByText('Chat interrupted by user.')).toBeTruthy();
		expect(container.querySelector('article')?.className).toContain('border-status-warning-border');
	});
});
