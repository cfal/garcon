import { describe, expect, it, vi } from 'vitest';
import {
	handlePermissionLifecycleFromBatch,
	type PermissionLifecycleContext,
} from '../handlers/permissions';
import {
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
	PermissionExpiredMessage,
	AssistantMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	WriteToolUseMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';

const PERMISSION_OCCURRENCE = 'incarnation-1';

function makeContext(initial: PendingPermissionRequest[] = []): {
	ctx: PermissionLifecycleContext;
	read: () => PendingPermissionRequest[];
	markTurnRunning: ReturnType<typeof vi.fn>;
	pushLoadingStatus: ReturnType<typeof vi.fn>;
	popLoadingStatus: ReturnType<typeof vi.fn>;
} {
	let pending = [...initial];
	const markTurnRunning = vi.fn();
	const pushLoadingStatus = vi.fn();
	const popLoadingStatus = vi.fn();
	const ctx: PermissionLifecycleContext = {
		conversationUi: {
			updatePendingPermissionsForChat: (_chatId, updater) => {
				pending = typeof updater === 'function' ? updater(pending) : updater;
			},
		},
		markTurnRunning,
		pushLoadingStatus,
		popLoadingStatus,
	};
	return { ctx, read: () => pending, markTurnRunning, pushLoadingStatus, popLoadingStatus };
}

function makeBatch(
	chatId: string,
	messages: ChatMessage[],
): { chatId: string; messages: ChatMessage[] } {
	return { chatId, messages };
}

describe('permissions handler (message-batch lifecycle)', () => {
	it('stores incoming permission request from message batch', () => {
		const { ctx, read } = makeContext();

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionRequestMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				),
			]),
			ctx,
		);

		const pending = read();
		expect(pending).toHaveLength(1);
		expect(pending[0].permissionOccurrenceId).toBe(PERMISSION_OCCURRENCE);
		expect(pending[0].requestedTool).toBeInstanceOf(BashToolUseMessage);
		expect((pending[0].requestedTool as BashToolUseMessage).command).toBe('ls');
	});

	it('pushes WAITING_FOR_PERMISSION status on permission request', () => {
		const { ctx, markTurnRunning, pushLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionRequestMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				),
			]),
			ctx,
		);

		expect(pushLoadingStatus).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ id: 'WAITING_FOR_PERMISSION' }),
		);
		expect(markTurnRunning).toHaveBeenCalledWith('chat-1');
	});

	it('pushes one status entry per concurrent permission request', () => {
		const { ctx, pushLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionRequestMessage(
					new Date().toISOString(),
					'incarnation-a',
					new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				),
				new PermissionRequestMessage(
					new Date().toISOString(),
					'incarnation-b',
					new ReadToolUseMessage(new Date().toISOString(), 'tool-2', 'foo.txt'),
				),
			]),
			ctx,
		);

		expect(pushLoadingStatus).toHaveBeenCalledTimes(2);
	});

	it('removes pending request and pops status on cancellation', () => {
		const { ctx, read, popLoadingStatus } = makeContext([
			{
				permissionOccurrenceId: PERMISSION_OCCURRENCE,
				requestedTool: new ReadToolUseMessage(new Date().toISOString(), 'tool-1', '/tmp/test'),
				chatId: 'chat-1',
			},
		]);

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionCancelledMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					'cancelled',
				),
			]),
			ctx,
		);

		expect(read()).toHaveLength(0);
		expect(popLoadingStatus).toHaveBeenCalledWith('chat-1', 'WAITING_FOR_PERMISSION');
	});

	it('pops WAITING_FOR_PERMISSION status on permission resolved', () => {
		const { ctx, read, popLoadingStatus } = makeContext([
			{
				permissionOccurrenceId: PERMISSION_OCCURRENCE,
				requestedTool: new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				chatId: 'chat-1',
			},
		]);

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionResolvedMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					true,
				),
			]),
			ctx,
		);

		expect(popLoadingStatus).toHaveBeenCalledWith('chat-1', 'WAITING_FOR_PERMISSION');
		expect(read()).toHaveLength(0);
	});

	it('removes only the expired permission occurrence', () => {
		const current = {
			permissionOccurrenceId: 'incarnation-current',
			requestedTool: new BashToolUseMessage(new Date().toISOString(), 'tool-current', 'pwd'),
			chatId: 'chat-1',
		};
		const expired = {
			...current,
			permissionOccurrenceId: 'incarnation-expired',
		};
		const { ctx, read } = makeContext([expired, current]);

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [new PermissionExpiredMessage(
				new Date().toISOString(),
				'incarnation-expired',
			)]),
			ctx,
		);

		expect(read()).toEqual([current]);
	});

	it.each([
		[
			'resolution',
			new PermissionResolvedMessage(
				'2026-08-15T00:00:00.000Z',
				'incarnation-old',
				true,
			),
		],
		[
			'cancellation',
			new PermissionCancelledMessage(
				'2026-08-15T00:00:00.000Z',
				'incarnation-old',
				'cancelled',
			),
		],
		[
			'expiry',
			new PermissionExpiredMessage(
				'2026-08-15T00:00:00.000Z',
				'incarnation-old',
			),
		],
	])('does not pop current permission status for a stale %s', (_label, terminal) => {
		const current = {
			permissionOccurrenceId: 'incarnation-current',
			requestedTool: new BashToolUseMessage(
				'2026-08-15T00:00:00.000Z',
				'tool-current',
				'pwd',
			),
			chatId: 'chat-1',
		};
		const { ctx, read, popLoadingStatus } = makeContext([current]);

		handlePermissionLifecycleFromBatch(makeBatch('chat-1', [terminal]), ctx);

		expect(read()).toEqual([current]);
		expect(popLoadingStatus).not.toHaveBeenCalled();
	});

	it('handles request then resolved in same batch', () => {
		const { ctx, read, pushLoadingStatus, popLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionRequestMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					new WriteToolUseMessage(new Date().toISOString(), 'tool-1', 'test.txt'),
				),
				new PermissionResolvedMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					true,
				),
			]),
			ctx,
		);

		expect(pushLoadingStatus).toHaveBeenCalledTimes(1);
		expect(popLoadingStatus).toHaveBeenCalledTimes(1);
		expect(read()).toHaveLength(0);
	});

	it('does not add duplicate permission requests or loading statuses', () => {
		const { ctx, read, markTurnRunning, pushLoadingStatus } = makeContext([
			{
				permissionOccurrenceId: PERMISSION_OCCURRENCE,
				requestedTool: new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				chatId: 'chat-1',
			},
		]);

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [
				new PermissionRequestMessage(
					new Date().toISOString(),
					PERMISSION_OCCURRENCE,
					new BashToolUseMessage(new Date().toISOString(), 'tool-1', 'ls'),
				),
			]),
			ctx,
		);

		expect(read()).toHaveLength(1);
		expect(markTurnRunning).not.toHaveBeenCalled();
		expect(pushLoadingStatus).not.toHaveBeenCalled();
	});

	it('ignores batches with no permission messages', () => {
		const { ctx, read, pushLoadingStatus, popLoadingStatus } = makeContext();

		handlePermissionLifecycleFromBatch(
			makeBatch('chat-1', [new AssistantMessage(new Date().toISOString(), 'Hello')]),
			ctx,
		);

		expect(read()).toHaveLength(0);
		expect(pushLoadingStatus).not.toHaveBeenCalled();
		expect(popLoadingStatus).not.toHaveBeenCalled();
	});
});
