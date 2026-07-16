import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarTranscriptSearchStatus from '../SidebarTranscriptSearchStatus.svelte';
import * as m from '$lib/paraglide/messages.js';

describe('SidebarTranscriptSearchStatus', () => {
	afterEach(cleanup);

	it('shows exact index progress only while the client is polling', () => {
		render(SidebarTranscriptSearchStatus, {
			enabled: true,
			indexing: true,
			index: {
				indexedChatCount: 1,
				pendingChatCount: 2,
				failedChatCount: 0,
				unsupportedChatCount: 0,
			},
		});

		const row = screen.getByRole('status');
		expect(row.textContent).toContain(
			m.sidebar_search_transcript_indexing_progress({ indexed: 1, pending: 2 }),
		);
		expect(row.classList.contains('h-8')).toBe(true);
		expect(row.classList.contains('shrink-0')).toBe(true);
	});

	it('keeps one row mounted and stops presenting a stale pending count as live', async () => {
		const view = render(SidebarTranscriptSearchStatus, {
			enabled: true,
			loading: true,
		});
		const statusRow = screen.getByRole('status');

		await view.rerender({
			enabled: true,
			loading: false,
			indexing: false,
			index: {
				indexedChatCount: 42,
				pendingChatCount: 7,
				failedChatCount: 0,
				unsupportedChatCount: 0,
			},
		});

		expect(screen.getByRole('status')).toBe(statusRow);
		expect(statusRow.textContent).toContain(
			m.sidebar_search_transcript_ready_indexed_plural({ count: 42 }),
		);
		expect(statusRow.textContent).not.toContain('7');
	});

	it('uses grammatically correct singular transcript counts', () => {
		render(SidebarTranscriptSearchStatus, {
			enabled: true,
			index: {
				indexedChatCount: 1,
				pendingChatCount: 0,
				failedChatCount: 1,
				unsupportedChatCount: 1,
			},
		});

		const text = screen.getByRole('status').textContent ?? '';
		expect(text).toContain(m.sidebar_search_transcript_ready_indexed_singular());
		expect(text).toContain(m.sidebar_search_transcript_failed_singular());
		expect(text).toContain(m.sidebar_search_transcript_unsupported_singular());
		expect(text).not.toContain('(s)');
	});

	it('renders no reserved row while transcript search is disabled', () => {
		render(SidebarTranscriptSearchStatus, {
			enabled: false,
			loading: true,
			indexing: true,
			index: {
				indexedChatCount: 42,
				pendingChatCount: 7,
				failedChatCount: 1,
				unsupportedChatCount: 1,
			},
			error: m.sidebar_search_transcript_error(),
		});

		expect(document.querySelector('[data-slot="transcript-search-status"]')).toBeNull();
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('uses the reserved row for retryable errors', async () => {
		const onRetry = vi.fn();
		render(SidebarTranscriptSearchStatus, {
			enabled: true,
			error: m.sidebar_search_transcript_error(),
			onRetry,
		});

		const row = screen.getByRole('alert');
		expect(row.textContent).toContain(m.sidebar_search_transcript_error());
		expect(row.classList.contains('h-8')).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: m.common_retry() }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
