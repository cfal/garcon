import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatSummary from '../ChatSummary.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session.js';

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
		canReloadFromNativeHistory: false,
		isUnread: true,
		status: 'running',
		lastMessage: 'A longer preview that remains readable inside a detailed board card.',
		tags: ['alpha', 'beta', 'gamma'],
		...overrides,
	};
}

describe('ChatSummary', () => {
	it('renders the detailed board hierarchy with bounded preview and processing status', () => {
		render(ChatSummary, {
			session: chat(),
			variant: 'board',
			chatItemLayout: 'detailed',
			showTimestamp: true,
			currentTime: new Date('2026-09-07T12:00:00.000Z'),
		});

		const summary = document.querySelector('[data-slot="chat-summary"]');
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
