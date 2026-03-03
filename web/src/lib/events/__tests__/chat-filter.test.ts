import { describe, expect, it } from 'vitest';
import { filterByChat } from '../chat-filter';

describe('filterByChat', () => {
	const ctx = {
		selectedChatId: 'chat-a',
		currentChatId: null,
		pendingViewChatId: null,
	};

	it('processes chat-title-updated as a global event regardless of chat ID', () => {
		const result = filterByChat(
			'chat-title-updated',
			{ type: 'chat-title-updated', chatId: 'chat-b', title: 'Hello' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('processes chat-processing-updated as a global event regardless of chat ID', () => {
		const result = filterByChat(
			'chat-processing-updated',
			{ type: 'chat-processing-updated', chatId: 'chat-b', isProcessing: false } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('processes queue-state-updated as a global event regardless of chat ID', () => {
		const result = filterByChat(
			'queue-state-updated',
			{ type: 'queue-state-updated', chatId: 'chat-b', queue: { entries: [], paused: false } } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('processes chat-session-created as a global event regardless of chat ID', () => {
		const result = filterByChat(
			'chat-session-created',
			{ type: 'chat-session-created', chatId: 'chat-b' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('processes chat-session-created when no active view chat exists', () => {
		const result = filterByChat(
			'chat-session-created',
			{ type: 'chat-session-created', chatId: 'chat-x' } as never,
			{ selectedChatId: null, currentChatId: null, pendingViewChatId: null },
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('skips scoped events for non-matching chats', () => {
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output', chatId: 'chat-b' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'skip' });
	});

	it('skips lifecycle events for non-matching chats', () => {
		const result = filterByChat(
			'agent-run-finished',
			{ type: 'agent-run-finished', chatId: 'chat-b' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'skip' });
	});

	it('processes chat-list-refresh-requested as a global event regardless of chat ID', () => {
		const result = filterByChat(
			'chat-list-refresh-requested',
			{ type: 'chat-list-refresh-requested', chatId: 'chat-b', reason: 'archive-toggled' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('processes scoped events for the active chat', () => {
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output', chatId: 'chat-a' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('skips scoped events with no chatId and no pending view', () => {
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output' } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'skip' });
	});

	it('skips scoped events when no active view chat exists', () => {
		const noActiveCtx = { selectedChatId: null, currentChatId: null, pendingViewChatId: null };
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output', chatId: 'chat-x' } as never,
			noActiveCtx,
		);
		expect(result).toEqual({ action: 'skip' });
	});

	it('handles message with non-string chatId gracefully', () => {
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output', chatId: 12345 } as never,
			ctx,
		);
		expect(result).toEqual({ action: 'skip' });
	});

	it('falls back to currentChatId when selectedChatId is null', () => {
		const fallbackCtx = { selectedChatId: null, currentChatId: 'chat-b', pendingViewChatId: null };
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output', chatId: 'chat-b' } as never,
			fallbackCtx,
		);
		expect(result).toEqual({ action: 'process' });
	});

	it('falls back to pendingViewChatId when both selected and current are null', () => {
		const fallbackCtx = { selectedChatId: null, currentChatId: null, pendingViewChatId: 'chat-c' };
		const result = filterByChat(
			'agent-run-output',
			{ type: 'agent-run-output', chatId: 'chat-c' } as never,
			fallbackCtx,
		);
		expect(result).toEqual({ action: 'process' });
	});
});
