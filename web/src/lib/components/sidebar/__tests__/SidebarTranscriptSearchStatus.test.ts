import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarTranscriptSearchStatus from '../SidebarTranscriptSearchStatus.svelte';
import * as m from '$lib/paraglide/messages.js';

describe('SidebarTranscriptSearchStatus', () => {
	afterEach(cleanup);

	it('[TLV5-SEARCH.11-UI-01] includes unindexed chats in visible progress', () => {
		render(SidebarTranscriptSearchStatus, {
			enabled: true,
			indexing: true,
			index: {
				indexedChatCount: 1,
				pendingChatCount: 2,
				failedChatCount: 0,
				unindexedChatCount: 3,
				unsupportedChatCount: 0,
				resultsTruncated: false,
			},
		});

		const row = screen.getByRole('status');
		expect(row.textContent).toContain(
			m.sidebar_search_transcript_indexing_progress({ indexed: 1, pending: 5 }),
		);
		expect(row.classList.contains('h-8')).toBe(true);
		expect(row.classList.contains('shrink-0')).toBe(true);
		expect(row.classList.contains('bg-chat-thinking')).toBe(true);
	});

	it('[TLV5-SEARCH.11-UI-02] discloses when a broad query returns a bounded recent sample', () => {
		render(SidebarTranscriptSearchStatus, {
			enabled: true,
			index: {
				indexedChatCount: 3,
				pendingChatCount: 0,
				failedChatCount: 0,
				unindexedChatCount: 0,
				unsupportedChatCount: 0,
				resultsTruncated: true,
			},
		});

		expect(screen.getByRole('status').textContent).toContain(
			m.sidebar_search_results_truncated(),
		);
	});

	it('[TLV5-SEARCH.09-UI-06] renders only exact resync progress states', async () => {
		const baseStatus = {
			version: 1 as const,
			phase: 'rebuilding' as const,
			chats: { total: 10, indexed: 3, pending: 7, failed: 0, unindexed: 0 },
			queuedJobs: 1,
			resync: { completedChats: 3, totalChats: 10 },
			backlogRows: 20,
			activeChat: null,
			lastErrorCode: null,
			updatedAt: '2026-08-19T00:00:00.000Z',
		};
		const view = render(SidebarTranscriptSearchStatus, {
			enabled: true,
			indexing: true,
			status: baseStatus,
		});
		const row = screen.getByRole('status');
		expect(row.textContent).toContain(m.sidebar_search_indexing_progress({ done: 3, total: 10 }));

		await view.rerender({
			enabled: true,
			indexing: true,
			status: { ...baseStatus, resync: { completedChats: 10, totalChats: 10 } },
		});
		expect(row.textContent).toContain(m.sidebar_search_finalizing());

		await view.rerender({
			enabled: true,
			indexing: true,
			status: { ...baseStatus, resync: null },
		});
		expect(row.textContent).toContain(m.sidebar_search_updating());
		expect(row.textContent).not.toContain('10');
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
				unindexedChatCount: 0,
				unsupportedChatCount: 0,
				resultsTruncated: false,
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
				unindexedChatCount: 0,
				unsupportedChatCount: 1,
				resultsTruncated: false,
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
				unindexedChatCount: 0,
				unsupportedChatCount: 1,
				resultsTruncated: false,
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
