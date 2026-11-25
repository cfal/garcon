import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserNotificationsRouter } from '../browser-notifications-router.js';
import { AgentRunFinishedMessage, ChatTransientFeedMutationMessage } from '$shared/ws-events';
import { BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import { openPushFixture } from '$lib/ws/__tests__/push-fixture';
import type { BrowserNotificationDeliveryPort } from '$lib/notifications/browser-notifications.js';

function permission(kind: 'upsert' | 'remove' | 'clear-run' = 'upsert') {
	return new ChatTransientFeedMutationMessage(
		'synthetic-instance',
		'background',
		'synthetic-view',
		1,
		kind === 'upsert'
			? {
					kind,
					row: {
						permissionOccurrenceId: 'occurrence',
						runId: 'run',
						transcript: { transcriptViewId: 'synthetic-view', afterOrdinal: 0 },
						displayOrder: 0,
						message: new PermissionRequestMessage(
							'2026-01-01T00:00:00Z',
							'occurrence',
							new BashToolUseMessage('2026-01-01T00:00:00Z', 'tool', 'synthetic-command'),
						),
					},
				}
			: kind === 'remove'
				? { kind, permissionOccurrenceId: 'occurrence' }
				: { kind, runId: 'run' },
	);
}

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
});

async function fixture(
	messages: unknown[],
	enabled = true,
	focused = false,
	processing = false,
	allowsNotifications = true,
) {
	let currentProcessing = processing;
	const connection = openPushFixture();
	const delivery = { show: vi.fn(), close: vi.fn(), closeOwned: vi.fn() } satisfies Pick<
		BrowserNotificationDeliveryPort,
		'show' | 'close' | 'closeOwned'
	>;
	const router = new BrowserNotificationsRouter(connection.ws, delivery, {
		enabled: () => enabled,
		isFocused: () => focused,
		isChatProcessing: () => currentProcessing,
		allowsNotifications: () => allowsNotifications,
	});
	dispose = () => {
		router.destroy();
		connection.close();
	};
	router.start();
	for (const message of messages) connection.send(message);
	await Promise.resolve();
	return {
		router,
		delivery,
		send: connection.send,
		setProcessing: (next: boolean) => {
			currentProcessing = next;
		},
	};
}

describe('root browser notifications routing', () => {
	it.each(['remove', 'clear-run'] as const)('leaves peer notifications alone on disconnect until authoritative %s', async (kind) => {
		const f = await fixture([permission()], true, true);
		expect(f.delivery.show).not.toHaveBeenCalled();
		f.router.releasePermissions();
		expect(f.delivery.closeOwned).toHaveBeenCalledExactlyOnceWith('permission:synthetic-instance:background:occurrence');
		expect(f.delivery.close).not.toHaveBeenCalled();
		f.send(permission(kind));
		expect(f.delivery.close).toHaveBeenCalledExactlyOnceWith('permission:synthetic-instance:background:occurrence');
	});
	it('suppresses intermediate queued completion and notifies after the queue becomes idle', async () => {
		const completed = new AgentRunFinishedMessage(
			'background',
			0,
			'turn',
			undefined,
			undefined,
			'finished',
		);
		const busy = await fixture([completed], true, false, true);
		expect(busy.delivery.show).not.toHaveBeenCalled();
		busy.setProcessing(false);
		busy.send(
			new AgentRunFinishedMessage('background', 0, 'next-turn', undefined, undefined, 'finished'),
		);
		expect(busy.delivery.show).toHaveBeenCalledWith(
			'Garcon: chat completed',
			'background',
			'completion:background:next-turn',
		);
		expect(busy.delivery.show).toHaveBeenCalledOnce();

	});
	it('suppresses completion and permission notifications without conversational policy', async () => {
		const completed = new AgentRunFinishedMessage(
			'background',
			0,
			'turn',
			undefined,
			undefined,
			'finished',
		);
		const f = await fixture([completed, permission()], true, false, false, false);
		expect(f.delivery.show).not.toHaveBeenCalled();

	});
	it.each(['remove', 'clear-run'] as const)(
		'closes permission notifications resolved by %s in a later tick',
		async (kind) => {
			const f = await fixture([permission()]);
			expect(f.delivery.show).toHaveBeenCalledOnce();
			f.send(permission(kind));
			expect(f.delivery.close).toHaveBeenCalledWith(
				'permission:synthetic-instance:background:occurrence',
			);
			expect(f.delivery.show).toHaveBeenCalledOnce();

		},
	);
	it('notifies background completions and live permissions once without private text', async () => {
		const completed = new AgentRunFinishedMessage(
			'background',
			0,
			'turn',
			undefined,
			undefined,
			'finished',
		);
		const f = await fixture([completed, completed, permission(), permission()]);
		expect(f.delivery.show.mock.calls.map((call) => call[0])).toEqual([
			'Garcon: chat completed',
			'Garcon: permission needed',
		]);
		expect(JSON.stringify(f.delivery.show.mock.calls)).not.toContain('synthetic-command');
		await Promise.resolve();
		expect(f.delivery.show).toHaveBeenCalledTimes(2);

	});
	it.each(['remove', 'clear-run'] as const)(
		'suppresses a permission resolved by %s in the same burst',
		async (kind) => {
			const f = await fixture([permission(), permission(kind)]);
			expect(f.delivery.show).not.toHaveBeenCalled();

		},
	);
	it('ignores snapshots, durable permission history, failed/interrupted completions', async () => {
		const f = await fixture([
			{ type: 'chat-transient-feed-snapshot', rows: [permission()] },
			{ type: 'chat-messages', messages: [permission()] },
			new AgentRunFinishedMessage('background', 0, 'turn', undefined, undefined, 'interrupted'),
			new AgentRunFinishedMessage('background', 1, 'turn', undefined, undefined, 'finished'),
		]);
		expect(f.delivery.show).not.toHaveBeenCalled();

	});
	it.each([
		[false, false],
		[true, true],
	])('suppresses delivery with enabled=%s and focused=%s', async (enabled, focused) => {
		const f = await fixture([permission()], enabled, focused);
		expect(f.delivery.show).not.toHaveBeenCalled();

	});
});
