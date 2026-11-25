import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptSearchStatusController } from '../transcript-search-status-controller';
import type { getTranscriptSearchStatus } from '$lib/api/chats';
import { openPushFixture } from '$lib/ws/__tests__/push-fixture';
import type { TranscriptSearchStatusV1, TranscriptSearchStatusResponse } from '$shared/chat-search';

const fixtures: ReturnType<typeof openPushFixture>[] = [];

function connect() {
	const connection = openPushFixture();
	fixtures.push(connection);
	return connection;
}

const status = {
	version: 1,
	phase: 'rebuilding',
	chats: { total: 5, indexed: 3, pending: 1, failed: 0, unindexed: 1 },
	queuedJobs: 1,
	resync: { completedChats: 3, totalChats: 4 },
	backlogRows: 12,
	activeChat: { position: 4, total: 10 },
	lastErrorCode: null,
	updatedAt: '2026-08-19T00:00:00.000Z',
} satisfies TranscriptSearchStatusV1;

const httpStatus = {
	...status,
	queryStats: {
		served: 0,
		timedOut: 0,
		rejectedBusy: 0,
		p50Ms: 0,
		p95Ms: 0,
		maxMs: 0,
		admissionP50Ms: 0,
		admissionP95Ms: 0,
		admissionMaxMs: 0,
		totalP50Ms: 0,
		totalP95Ms: 0,
		totalMaxMs: 0,
	},
} satisfies TranscriptSearchStatusResponse;

describe('TranscriptSearchStatusController', () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0).reverse()) fixture.close();
	});

	it('delivers each valid push immediately until unsubscribed', () => {
		const connection = connect();
		const next = { ...status, chats: { ...status.chats, indexed: 4 } };
		const onStatus = vi.fn();
		const controller = new TranscriptSearchStatusController(connection.ws, onStatus);

		controller.start();
		controller.start();
		connection.send({ type: 'transcript-search-status', status });
		connection.send({ type: 'settings-changed', settings: {} });
		connection.send({ type: 'transcript-search-status', status: {} });
		connection.send({ type: 'transcript-search-status', status: next });
		controller.destroy();
		connection.send({ type: 'transcript-search-status', status });

		expect(onStatus.mock.calls).toEqual([[status], [next]]);
	});

	it('keeps newer WebSocket status when an older HTTP response arrives', async () => {
		const pending = Promise.withResolvers<TranscriptSearchStatusResponse>();
		const getStatus = vi.fn<typeof getTranscriptSearchStatus>().mockReturnValue(pending.promise);
		const onStatus = vi.fn();
		const connection = connect();
		const controller = new TranscriptSearchStatusController(connection.ws, onStatus, getStatus);
		controller.start();
		const refreshing = controller.refresh();
		const pushed = { ...status, phase: 'ready' as const };
		connection.send({ type: 'transcript-search-status', status: pushed });
		pending.resolve(httpStatus);
		await refreshing;
		expect(onStatus).toHaveBeenCalledExactlyOnceWith(pushed);
		expect(getStatus.mock.calls[0][0]?.signal?.aborted).toBe(true);
		controller.destroy();
	});

	it('keeps the newest reconnect response when requests finish backwards', async () => {
		const first = Promise.withResolvers<TranscriptSearchStatusResponse>();
		const second = Promise.withResolvers<TranscriptSearchStatusResponse>();
		const getStatus = vi
			.fn<typeof getTranscriptSearchStatus>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const onStatus = vi.fn();
		const controller = new TranscriptSearchStatusController(connect().ws, onStatus, getStatus);
		controller.start();
		const older = controller.refresh();
		const newer = controller.refresh();
		const restarted = { ...httpStatus, chats: { ...status.chats, indexed: 0 } };
		second.resolve(restarted);
		await newer;
		first.resolve(httpStatus);
		await older;
		expect(onStatus).toHaveBeenCalledExactlyOnceWith(restarted);
		controller.destroy();
	});

	it.each(['cancelRefresh', 'destroy'] as const)(
		'ignores late responses after %s',
		async (cleanupMethod) => {
			const pending = Promise.withResolvers<TranscriptSearchStatusResponse>();
			const getStatus = vi.fn<typeof getTranscriptSearchStatus>().mockReturnValue(pending.promise);
			const onStatus = vi.fn();
			const controller = new TranscriptSearchStatusController(connect().ws, onStatus, getStatus);
			controller.start();
			const refreshing = controller.refresh();
			controller[cleanupMethod]();
			pending.resolve(httpStatus);
			await refreshing;
			expect(onStatus).not.toHaveBeenCalled();
			expect(getStatus.mock.calls[0][0]?.signal?.aborted).toBe(true);
			controller.destroy();
		},
	);

	it('publishes successful refreshes and retains them on transient failure', async () => {
		const getStatus = vi
			.fn<typeof getTranscriptSearchStatus>()
			.mockResolvedValueOnce(httpStatus)
			.mockRejectedValueOnce(new Error('Offline'));
		const onStatus = vi.fn();
		const controller = new TranscriptSearchStatusController(connect().ws, onStatus, getStatus);
		controller.start();
		await controller.refresh();
		await controller.refresh();
		expect(onStatus).toHaveBeenCalledExactlyOnceWith(httpStatus);
		controller.destroy();
		await controller.refresh();
		expect(getStatus).toHaveBeenCalledTimes(2);
	});
});
