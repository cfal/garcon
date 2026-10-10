import { describe, expect, it, vi } from 'vitest';
import { BrowserNotificationsRouter } from '../browser-notifications-router.js';
import { AgentRunFinishedMessage, ChatTransientFeedMutationMessage } from '$shared/ws-events';
import { BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import type { WsMessageLog } from '$lib/ws/drain';
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

function fixture(messages: unknown[], enabled = true, focused = false, processing = false, allowsNotifications = true) {
	let currentProcessing = processing;
	const ws = {
		messages: messages.map((data) => ({
			data: JSON.parse(JSON.stringify(data)),
			timestamp: Date.now(),
		})),
		trimOffset: 0,
		registerCursor: vi.fn(() => vi.fn()),
	} satisfies WsMessageLog;
	const delivery = { show: vi.fn(), close: vi.fn() } satisfies Pick<BrowserNotificationDeliveryPort, 'show' | 'close'>;
	const router = new BrowserNotificationsRouter(ws, delivery, {
		enabled: () => enabled,
		isFocused: () => focused,
		isChatProcessing: () => currentProcessing,
		allowsNotifications: () => allowsNotifications,
	});
	router.start();
	router.tick();
	return {
		ws,
		delivery,
		router,
		setProcessing: (next: boolean) => {
			currentProcessing = next;
		},
	};
}

describe('root browser notifications routing', () => {
	it('suppresses intermediate queued completion and notifies after the queue becomes idle', () => {
		const completed = new AgentRunFinishedMessage(
			'background',
			0,
			'turn',
			undefined,
			undefined,
			'finished',
		);
		const busy = fixture([completed], true, false, true);
		expect(busy.delivery.show).not.toHaveBeenCalled();
		busy.setProcessing(false);
		busy.ws.messages.push({
			data: JSON.parse(
				JSON.stringify(
					new AgentRunFinishedMessage(
						'background',
						0,
						'next-turn',
						undefined,
						undefined,
						'finished',
					),
				),
			),
			timestamp: Date.now(),
		});
		busy.router.tick();
		expect(busy.delivery.show).toHaveBeenCalledWith(
			'Garcon: chat completed',
			'background',
			'completion:background:next-turn',
		);
		expect(busy.delivery.show).toHaveBeenCalledOnce();
		busy.router.destroy();
	});
	it('suppresses completion and permission notifications without conversational policy', () => {
		const completed = new AgentRunFinishedMessage(
			'background',
			0,
			'turn',
			undefined,
			undefined,
			'finished',
		);
		const f = fixture([completed, permission()], true, false, false, false);
		expect(f.delivery.show).not.toHaveBeenCalled();
		f.router.destroy();
	});
	it.each(['remove', 'clear-run'] as const)(
		'closes permission notifications resolved by %s in a later tick',
		(kind) => {
			const f = fixture([permission()]);
			expect(f.delivery.show).toHaveBeenCalledOnce();
			f.ws.messages.push({
				data: JSON.parse(JSON.stringify(permission(kind))),
				timestamp: Date.now(),
			});
			f.router.tick();
			expect(f.delivery.close).toHaveBeenCalledWith(
				'permission:synthetic-instance:background:occurrence',
			);
			expect(f.delivery.show).toHaveBeenCalledOnce();
			f.router.destroy();
		},
	);
	it('notifies background completions and live permissions once without private text', () => {
		const completed = new AgentRunFinishedMessage(
			'background',
			0,
			'turn',
			undefined,
			undefined,
			'finished',
		);
		const f = fixture([completed, completed, permission(), permission()]);
		expect(f.delivery.show.mock.calls.map((call) => call[0])).toEqual([
			'Garcon: chat completed',
			'Garcon: permission needed',
		]);
		expect(JSON.stringify(f.delivery.show.mock.calls)).not.toContain('synthetic-command');
		f.router.tick();
		expect(f.delivery.show).toHaveBeenCalledTimes(2);
		f.router.destroy();
	});
	it.each(['remove', 'clear-run'] as const)(
		'suppresses a permission resolved by %s in the same drain',
		(kind) => {
			const f = fixture([permission(), permission(kind)]);
			expect(f.delivery.show).not.toHaveBeenCalled();
			f.router.destroy();
		},
	);
	it('ignores snapshots, durable permission history, failed/interrupted completions', () => {
		const f = fixture([
			{ type: 'chat-transient-feed-snapshot', rows: [permission()] },
			{ type: 'chat-messages', messages: [permission()] },
			new AgentRunFinishedMessage('background', 0, 'turn', undefined, undefined, 'interrupted'),
			new AgentRunFinishedMessage('background', 1, 'turn', undefined, undefined, 'finished'),
		]);
		expect(f.delivery.show).not.toHaveBeenCalled();
		f.router.destroy();
	});
	it.each([
		[false, false],
		[true, true],
	])('suppresses delivery with enabled=%s and focused=%s', (enabled, focused) => {
		const f = fixture([permission()], enabled, focused);
		expect(f.delivery.show).not.toHaveBeenCalled();
		f.router.destroy();
	});
});
