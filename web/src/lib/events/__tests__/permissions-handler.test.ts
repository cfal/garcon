import { describe, expect, it, vi } from 'vitest';
import { handlePermissionLifecycleFromBatch, type PermissionLifecycleContext } from '../handlers/permissions';
import { AgentRunOutputMessage } from '$shared/ws-events';
import {
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
	AssistantMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	WriteToolUseMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';

function makeContext(initial: PendingPermissionRequest[] = []): {
	ctx: PermissionLifecycleContext;
	read: () => PendingPermissionRequest[];
	pushLoadingStatus: ReturnType<typeof vi.fn>;
	popLoadingStatus: ReturnType<typeof vi.fn>;
} {
	let pending = [...initial];
	const pushLoadingStatus = vi.fn();
	const popLoadingStatus = vi.fn();
	const ctx: PermissionLifecycleContext = {
		currentChatId: 'chat-1',
		setPendingPermissionRequests: (updater) => {
			pending = updater(pending);
		},
		activateLoadingFor: () => {},
		setCanAbort: () => {},
		pushLoadingStatus,
		popLoadingStatus,
	};
	return { ctx, read: () => pending, pushLoadingStatus, popLoadingStatus };
}

function makeAgentResponse(chatId: string, messages: ChatMessage[]): AgentRunOutputMessage {
	return new AgentRunOutputMessage(chatId, messages);
}

describe('permissions handler (message-batch lifecycle)', () => {
	it('stores incoming permission request from message batch', () => {
		const { ctx, read } = makeContext();

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionRequestMessage(new Date().toISOString(), 'claude-abc123', new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls')),
		]), ctx);

		const pending = read();
		expect(pending).toHaveLength(1);
		expect(pending[0].permissionRequestId).toBe('claude-abc123');
		expect(pending[0].requestedTool).toBeInstanceOf(BashToolUseMessage);
		expect((pending[0].requestedTool as BashToolUseMessage).command).toBe('ls');
	});

	it('pushes WAITING_FOR_PERMISSION status on permission request', () => {
		const { ctx, pushLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionRequestMessage(new Date().toISOString(), 'claude-abc123', new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls')),
		]), ctx);

		expect(pushLoadingStatus).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'WAITING_FOR_PERMISSION' }),
		);
	});

	it('pushes one status entry per concurrent permission request', () => {
		const { ctx, pushLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionRequestMessage(new Date().toISOString(), 'claude-aaa', new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls')),
			new PermissionRequestMessage(new Date().toISOString(), 'claude-bbb', new ReadToolUseMessage(new Date().toISOString(), 'tool-2', 'foo.txt')),
		]), ctx);

		expect(pushLoadingStatus).toHaveBeenCalledTimes(2);
	});

	it('removes pending request and pops status on cancellation', () => {
		const { ctx, read, popLoadingStatus } = makeContext([
			{
				permissionRequestId: 'claude-abc123',
				requestedTool: new ReadToolUseMessage(new Date().toISOString(), 'tool-1', '/tmp/test'),
				chatId: 'chat-1',
			},
		]);

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionCancelledMessage(new Date().toISOString(), 'claude-abc123', 'cancelled'),
		]), ctx);

		expect(read()).toHaveLength(0);
		expect(popLoadingStatus).toHaveBeenCalledWith('WAITING_FOR_PERMISSION');
	});

	it('pops WAITING_FOR_PERMISSION status on permission resolved', () => {
		const { ctx, read, popLoadingStatus } = makeContext([
			{
				permissionRequestId: 'claude-abc123',
				requestedTool: new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				chatId: 'chat-1',
			},
		]);

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionResolvedMessage(new Date().toISOString(), 'claude-abc123', true),
		]), ctx);

		expect(popLoadingStatus).toHaveBeenCalledWith('WAITING_FOR_PERMISSION');
		expect(read()).toHaveLength(0);
	});

	it('handles request then resolved in same batch', () => {
		const { ctx, read, pushLoadingStatus, popLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionRequestMessage(new Date().toISOString(), 'claude-xyz', new WriteToolUseMessage(new Date().toISOString(), 'tool-1', 'test.txt')),
			new PermissionResolvedMessage(new Date().toISOString(), 'claude-xyz', true),
		]), ctx);

		expect(pushLoadingStatus).toHaveBeenCalledTimes(1);
		expect(popLoadingStatus).toHaveBeenCalledTimes(1);
		expect(read()).toHaveLength(0);
	});

	it('does not add duplicate permission requests', () => {
		const { ctx, read } = makeContext([
			{
				permissionRequestId: 'claude-abc123',
				requestedTool: new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				chatId: 'chat-1',
			},
		]);

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new PermissionRequestMessage(new Date().toISOString(), 'claude-abc123', new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls')),
		]), ctx);

		expect(read()).toHaveLength(1);
	});

	it('ignores batches with no permission messages', () => {
		const { ctx, read, pushLoadingStatus, popLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(makeAgentResponse('chat-1', [
			new AssistantMessage(new Date().toISOString(), 'Hello'),
		]), ctx);

		expect(read()).toHaveLength(0);
		expect(pushLoadingStatus).not.toHaveBeenCalled();
		expect(popLoadingStatus).not.toHaveBeenCalled();
	});
});
