import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatSummary from '../ChatSummary.svelte';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';

const currentTime = new Date('2026-09-07T12:00:00.000Z');

function chat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-summary',
		parentChatId: null,
		lineage: null,
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
		observation: null, canReloadFromNativeHistory: false,
		isUnread: true,
		status: 'running',
		lastMessage: 'A longer preview that remains readable inside a detailed board card.',
		tags: ['alpha', 'beta', 'gamma'],
		...overrides,
	};
}

describe('ChatSummary', () => {
	it.each(['sidebar', 'board'] as const)('shows native child activity independently of execution in %s', async (variant) => {
		const session = chat({
			isProcessing: false, processingPhase: null,
			observation: { kind: 'native-child', captureStatus: 'attached', isWorking: true },
		});
		const view = render(ChatSummary, { session, variant });
		expect(screen.getByText('Native subagent (read-only)')).toBeTruthy();
		expect(screen.getByText('Chat is processing')).toBeTruthy();
		await view.rerender({ session: {
			...session, observation: { kind: 'native-child', captureStatus: 'detached', isWorking: false },
		} });
		expect(screen.queryByText('Chat is processing')).toBeNull();
		expect(screen.getByText('Native subagent (read-only)')).toBeTruthy();
	});

	it.each(['single-line', 'compact', 'detailed'] as const)(
		'keeps the title first and shows only the applicable trailing metadata in %s rows',
		async (chatItemLayout) => {
			const view = render(ChatSummary, {
				session: chat(),
				variant: 'sidebar',
				chatItemLayout,
				showTimestamp: true,
				currentTime,
			});
			const title = screen.getByText('Polished board card');
			const header = title.parentElement!;
			for (const { activityStatus, isProcessing, expectedMetadata } of [
				{ activityStatus: null, isProcessing: false, expectedMetadata: ['1h ago'] },
				{ activityStatus: 'working', isProcessing: true, expectedMetadata: ['Chat is processing'] },
				{
					activityStatus: 'pending-user-action',
					isProcessing: true,
					expectedMetadata: ['Pending user action'],
				},
				{
					activityStatus: 'error',
					isProcessing: false,
					expectedMetadata: ['1h ago', 'Chat error'],
				},
				{ activityStatus: 'complete', isProcessing: false, expectedMetadata: ['1h ago'] },
			] as const) {
				await view.rerender({ session: chat({ activityStatus, isProcessing }) });
				expect(header.firstElementChild).toBe(title);
				const trailing = header.lastElementChild!;
				expect(trailing.classList.contains('ml-auto')).toBe(true);
				const metadata = Array.from(trailing.children, (item) => item.textContent?.trim());
				expect(metadata).toEqual(expectedMetadata);
			}
		},
	);

	it('keeps a completed title bold until read without changing its timestamp', async () => {
		const session = chat({ activityStatus: 'complete', isProcessing: false });
		const view = render(ChatSummary, {
			session,
			variant: 'sidebar',
			showTimestamp: true,
			currentTime,
		});
		const title = screen.getByText('Polished board card');
		expect(title.classList.contains('font-bold')).toBe(true);
		expect(screen.getByText('Unread')).toBeTruthy();
		await view.rerender({ session: { ...session, isUnread: false } });
		expect(title.classList.contains('font-bold')).toBe(false);
		expect(screen.queryByText('Unread')).toBeNull();
		expect(screen.getByText('1h ago')).toBeTruthy();
	});

	it('uses processing authority and never reserves space for a stale or absent status', async () => {
		const view = render(ChatSummary, {
			session: chat({ activityStatus: 'error', isUnread: false }),
			variant: 'sidebar',
		});
		const title = screen.getByText('Polished board card');
		const header = title.parentElement!;
		expect(header.querySelector('[data-status="working"]')).toBeTruthy();
		expect(screen.queryByText('Chat error')).toBeNull();
		for (const activityStatus of ['working', 'pending-user-action', 'complete', null] as const) {
			await view.rerender({
				session: chat({ activityStatus, isProcessing: false, isUnread: false }),
			});
			expect(Array.from(header.children)).toEqual([title]);
		}
		await view.rerender({ session: chat({ activityStatus: 'error', isProcessing: false }) });
		expect(screen.getByText('Chat error')).toBeTruthy();
	});

	it.each(['single-line', 'compact', 'detailed'] as const)(
		'builds the %s sidebar layout on the same title and optional path line',
		async (chatItemLayout) => {
			const session = chat({ isProcessing: false });
			const view = render(ChatSummary, {
				session,
				variant: 'sidebar',
				chatItemLayout,
				showTimestamp: true,
				showProjectPath: false,
				currentTime,
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
			await view.rerender({ session: { ...session, projectPath: '   ' } });
			expect(summary.querySelector('[data-slot="chat-project-path"]')).toBeNull();
			expect(header.querySelector('[data-slot="sidebar-chat-timestamp-badge"]')).toBeTruthy();
		},
	);

	it('renders the detailed board hierarchy with bounded preview and processing status', () => {
		render(ChatSummary, {
			session: chat(),
			variant: 'board',
			chatItemLayout: 'detailed',
			showTimestamp: true,
			currentTime,
		});

		const summary = document.querySelector('[data-slot="chat-summary"]');
		expect(summary?.querySelector('[data-slot="chat-activity-indicator"]')).toBeNull();
		expect(summary?.getAttribute('data-layout')).toBe('detailed');
		expect(screen.getByText(/A longer preview/).className).toContain('line-clamp-2');
		expect(screen.getByText('sonnet')).toBeTruthy();
		expect(screen.getByText('1h ago')).toBeTruthy();
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
