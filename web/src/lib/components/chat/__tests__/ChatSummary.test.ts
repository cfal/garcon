import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatSummary from '../ChatSummary.svelte';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';

function chat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-summary',
		parentChat: null,
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title: 'Polished board card',
		agentId: 'claude',
		agentOwnershipEpoch: null,
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-09-07T10:00:00.000Z',
		lastActivityAt: '2026-09-07T11:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: true,
		processingPhase: 'running',
		activityStatus: null,
		canReloadFromNativeHistory: false,
		isUnread: true,
		status: 'running',
		lastMessage: 'A longer preview that remains readable inside a detailed board card.',
		tags: ['alpha', 'beta', 'gamma'],
		...overrides,
	};
}

describe('ChatSummary', () => {
	it.each(['single-line', 'compact', 'detailed'] as const)(
		'keeps the leading status slot and title stable through transitions in %s rows',
		async (chatItemLayout) => {
			const view = render(ChatSummary, {
				session: chat({ isProcessing: false, processingPhase: null }),
				variant: 'sidebar',
				chatItemLayout,
				showTimestamp: true,
				currentTime: new Date('2026-09-07T12:00:00.000Z'),
			});
			const slot = view.container.querySelector('[data-slot="sidebar-chat-status"]');
			const title = screen.getByText('Polished board card');
			expect(slot?.nextElementSibling).toBe(title);
			expect(slot?.classList.contains('size-4')).toBe(true);
			expect(slot?.classList.contains('shrink-0')).toBe(true);
			expect(slot?.getAttribute('aria-hidden')).toBe('true');

			for (const activityStatus of [
				'working',
				'pending-user-action',
				'complete',
				'error',
			] as const) {
				const isProcessing =
					activityStatus === 'working' || activityStatus === 'pending-user-action';
				await view.rerender({
					session: chat({
						activityStatus,
						isProcessing,
						processingPhase: isProcessing ? 'running' : null,
					}),
				});
				expect(view.container.querySelector('[data-slot="sidebar-chat-status"]')).toBe(slot);
				expect(slot?.getAttribute('data-status')).toBe(activityStatus);
				expect(slot?.nextElementSibling).toBe(title);
				expect(slot?.getAttribute('title')).toBeTruthy();
				expect(slot?.querySelector('.sr-only')?.textContent).toBe(slot?.getAttribute('title'));
				expect(
					view.container.querySelector('[data-slot="sidebar-chat-timestamp-badge"]'),
				).toBeTruthy();
			}
		},
	);

	it('uses processing authority while discarding stale active display status', async () => {
		const view = render(ChatSummary, {
			session: chat({ activityStatus: 'complete' }),
			variant: 'sidebar',
		});
		const slot = view.container.querySelector('[data-slot="sidebar-chat-status"]');
		expect(slot?.getAttribute('data-status')).toBe('working');
		await view.rerender({ session: chat({ activityStatus: 'pending-user-action' }) });
		expect(slot?.getAttribute('data-status')).toBe('pending-user-action');
		for (const activityStatus of ['working', 'pending-user-action'] as const) {
			await view.rerender({
				session: chat({ activityStatus, isProcessing: false, processingPhase: null }),
			});
			expect(slot?.hasAttribute('data-status')).toBe(false);
		}
	});

	it.each(['single-line', 'compact', 'detailed'] as const)(
		'builds the %s sidebar layout on the same title and optional path line',
		async (chatItemLayout) => {
			const view = render(ChatSummary, {
				session: chat({ isProcessing: false }),
				variant: 'sidebar',
				chatItemLayout,
				showTimestamp: true,
				showProjectPath: false,
				currentTime: new Date('2026-09-07T12:00:00.000Z'),
			});
			const summary = view.container.querySelector('[data-slot="sidebar-chat-summary"]')!;
			expect(summary.className).toContain('flex-col gap-1');
			const header = summary.firstElementChild!;
			expect(header.getAttribute('data-slot')).toBe('chat-summary-header');
			expect(header.querySelector('[data-slot="sidebar-chat-timestamp-badge"]')).toBeTruthy();
			expect(summary.querySelector('[data-slot="chat-project-path"]')).toBeNull();
			await view.rerender({ showProjectPath: true });
			expect(header.nextElementSibling?.getAttribute('data-slot')).toBe('chat-project-path');
			expect(header.nextElementSibling?.textContent?.trim()).toBe('/workspace/project');
			expect(summary.querySelectorAll('[data-slot="sidebar-chat-timestamp-badge"]')).toHaveLength(
				1,
			);
			expect(Boolean(summary.querySelector('[data-slot="chat-summary-pills"]'))).toBe(
				chatItemLayout !== 'single-line',
			);
			if (chatItemLayout === 'detailed') {
				expect(summary.lastElementChild?.getAttribute('data-slot')).toBe('chat-preview');
			}
			await view.rerender({ session: chat({ projectPath: '   ' }) });
			expect(summary.querySelector('[data-slot="chat-project-path"]')).toBeNull();
			expect(summary.querySelector('[data-slot="sidebar-chat-timestamp-badge"]')).toBeTruthy();
			expect(header.querySelector('[data-slot="sidebar-chat-processing-indicator"]')).toBeTruthy();
		},
	);

	it('renders the detailed board hierarchy with bounded preview and processing status', () => {
		render(ChatSummary, {
			session: chat(),
			variant: 'board',
			chatItemLayout: 'detailed',
			showTimestamp: true,
			currentTime: new Date('2026-09-07T12:00:00.000Z'),
		});

		const summary = document.querySelector('[data-slot="chat-summary"]');
		expect(summary?.querySelector('[data-slot="sidebar-chat-status"]')).toBeNull();
		expect(summary?.getAttribute('data-layout')).toBe('detailed');
		expect(screen.getByText(/A longer preview/).className).toContain('line-clamp-2');
		expect(screen.getByText('sonnet')).toBeTruthy();
		expect(screen.getByText('Chat is processing')).toBeTruthy();
		expect(document.querySelector('[data-slot="chat-board-processing-indicator"]')).toBeTruthy();
	});

	it.each(['compact', 'single-line'] as const)('omits previews in %s board mode', (layout) => {
		render(ChatSummary, {
			session: chat({ isProcessing: false, processingPhase: null }),
			variant: 'board',
			chatItemLayout: layout,
		});

		expect(screen.queryByText(/A longer preview/)).toBeNull();
		expect(document.querySelector('[data-slot="chat-summary"]')?.getAttribute('data-layout')).toBe(
			layout,
		);
	});

	it('wraps board titles while keeping sidebar titles truncated', () => {
		const board = render(ChatSummary, {
			session: chat({ isProcessing: false, processingPhase: null }),
			variant: 'board',
			chatItemLayout: 'single-line',
		});
		const boardTitle = board.container.querySelector<HTMLElement>(
			'[data-variant="board"] [title="Polished board card"]',
		);
		expect(boardTitle?.classList.contains('line-clamp-2')).toBe(true);
		expect(boardTitle?.classList.contains('whitespace-normal')).toBe(true);
		expect(boardTitle?.classList.contains('break-words')).toBe(true);
		expect(boardTitle?.classList.contains('truncate')).toBe(false);

		const sidebar = render(ChatSummary, {
			session: chat({ isProcessing: false, processingPhase: null }),
			variant: 'sidebar',
			chatItemLayout: 'single-line',
		});
		const sidebarTitle = sidebar.container.querySelector<HTMLElement>(
			'[data-variant="sidebar"] [title="Polished board card"]',
		);
		expect(sidebarTitle?.classList.contains('truncate')).toBe(true);
		expect(sidebarTitle?.classList.contains('line-clamp-2')).toBe(false);
	});
});
