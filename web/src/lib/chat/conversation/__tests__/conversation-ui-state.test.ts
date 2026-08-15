import { describe, expect, it, vi } from 'vitest';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import type {
	ChatExecutionControlState,
	ChatQueueState,
	PendingPermissionRequest,
} from '$lib/types/chat';
import { BashToolUseMessage } from '$shared/chat-types';

function makeQueue(overrides: Partial<ChatQueueState> = {}): ChatQueueState {
	return {
		entries: [],
		steeringEntryId: null,
		recentlyDispatched: [],
		pause: null,
		reorderRevision: 0,
		...overrides,
	};
}

function makeControl(
	queue: ChatQueueState = makeQueue(),
	overrides: Partial<ChatExecutionControlState> = {},
): ChatExecutionControlState {
	return {
		serverInstanceId: 'server-instance-test',
		queue,
		version: 0,
		updatedAt: null,
		...overrides,
	};
}

function makeEntry(id: string, content: string, revision = 1) {
	return {
		id,
		content,
		revision,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

function makePermissionRequest(id: string, chatId: string | null = null): PendingPermissionRequest {
	return {
		permissionRequestId: id,
		incarnation: `incarnation-${id}`,
		requestedTool: new BashToolUseMessage('2026-07-15T00:00:00.000Z', `tool-${id}`, 'echo test'),
		chatId,
	};
}

describe('ConversationUiState', () => {
	it('updates pending permission requests through values or updater functions', () => {
		const store = new ConversationUiState();
		const first = makePermissionRequest('one');

		store.setPendingPermissionRequests([first]);
		store.setPendingPermissionRequests((previous) => [
			...previous,
			makePermissionRequest('two', 'chat-1'),
		]);

		expect(store.pendingPermissionRequests.map((request) => request.permissionRequestId)).toEqual([
			'one',
			'two',
		]);

		store.clearPendingPermissionRequests();

		expect(store.pendingPermissionRequests).toEqual([]);
	});

	it('clears turn requests while preserving plan-exit decisions', () => {
		const store = new ConversationUiState();
		store.setPendingPermissionRequests([
			makePermissionRequest('tool-request'),
			makePermissionRequest('plan-exit-confirmation'),
		]);

		store.clearTurnPermissionRequests();

		expect(store.pendingPermissionRequests.map((request) => request.permissionRequestId)).toEqual([
			'plan-exit-confirmation',
		]);
	});

	it('stores execution controls by chat and prunes controls for removed chats', () => {
		const store = new ConversationUiState();
		const control = makeControl();

		store.setExecutionControlFromLiveUpdate('chat-a', control);
		store.setExecutionControlFromLiveUpdate('chat-b', control);
		store.pruneExecutionControls(new Set(['chat-a']));

		expect(store.getExecutionControl('chat-a')).toEqual(control);
		expect(store.getExecutionControl('chat-b')).toBeNull();
		expect(store.executionControlChatIds).toEqual(['chat-a']);
	});

	it('does not let refresh responses overwrite same-version live execution-control state', () => {
		const store = new ConversationUiState();
		const live = makeControl(makeQueue({ entries: [makeEntry('entry-live', 'live')] }), {
			version: 4,
		});
		const staleRefresh = makeControl(
			makeQueue({
				entries: [makeEntry('entry-refresh', 'stale')],
				pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-01-01T00:00:00.000Z' },
			}),
			{ version: 4 },
		);

		store.setExecutionControlFromLiveUpdate('chat-a', live);
		store.setExecutionControlFromRefresh('chat-a', staleRefresh);

		expect(store.getExecutionControl('chat-a')).toEqual(live);
	});

	it('orders live and refresh revisions only within one server instance', () => {
		const store = new ConversationUiState();
		const versionFour = makeControl(makeQueue({ entries: [makeEntry('entry-four', 'four')] }), {
			version: 4,
		});
		const equalLive = makeControl(
			makeQueue({ entries: [makeEntry('entry-equal', 'equal-live')] }),
			{ version: 4 },
		);
		store.setExecutionControlFromLiveUpdate('chat-a', versionFour);

		store.setExecutionControlFromLiveUpdate('chat-a', equalLive);
		expect(store.getExecutionControl('chat-a')).toEqual(equalLive);
		store.setExecutionControlFromLiveUpdate('chat-a', makeControl(makeQueue(), { version: 3 }));
		expect(store.getExecutionControl('chat-a')).toEqual(equalLive);

		const versionFive = makeControl(makeQueue(), { version: 5 });
		store.setExecutionControlFromLiveUpdate('chat-a', versionFive);
		expect(store.getExecutionControl('chat-a')).toEqual(versionFive);
		store.setExecutionControlFromRefresh('chat-a', makeControl(makeQueue(), { version: 5 }));
		store.setExecutionControlFromRefresh('chat-a', makeControl(makeQueue(), { version: 4 }));
		expect(store.getExecutionControl('chat-a')).toEqual(versionFive);

		const versionSix = makeControl(makeQueue(), { version: 6 });
		store.setExecutionControlFromRefresh('chat-a', versionSix);
		expect(store.getExecutionControl('chat-a')).toEqual(versionSix);
	});

	it('replaces every cached control when correlated socket authority changes', () => {
		const store = new ConversationUiState();
		store.setExecutionControlFromLiveUpdate(
			'chat-a',
			makeControl(makeQueue(), {
				serverInstanceId: 'server-a',
				version: 8,
			}),
		);
		store.setExecutionControlFromLiveUpdate(
			'chat-b',
			makeControl(makeQueue(), {
				serverInstanceId: 'server-a',
				version: 3,
			}),
		);

		store.confirmExecutionControlSocketInstance('server-b');

		expect(store.executionControlChatIds).toEqual([]);
		expect(store.getExecutionControl('chat-a')).toBeNull();
	});

	it('retains controls across a transient socket disconnect', () => {
		const store = new ConversationUiState();
		const control = makeControl(makeQueue(), { serverInstanceId: 'server-a', version: 2 });
		store.confirmExecutionControlSocketInstance('server-a');
		store.setExecutionControlFromLiveUpdate('chat-a', control);

		store.markExecutionControlSocketDisconnected();

		expect(store.getExecutionControl('chat-a')).toEqual(control);
	});

	it('preserves instance authority when chat controls are pruned', () => {
		const store = new ConversationUiState();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		store.confirmExecutionControlSocketInstance('server-a');
		store.setExecutionControlFromLiveUpdate(
			'chat-a',
			makeControl(makeQueue(), { serverInstanceId: 'server-a' }),
		);
		store.pruneExecutionControls(new Set());
		store.markExecutionControlSocketDisconnected();
		store.setExecutionControlFromLiveUpdate(
			'chat-b',
			makeControl(makeQueue(), { serverInstanceId: 'server-b' }),
		);

		store.setExecutionControlFromRefresh(
			'chat-a',
			makeControl(makeQueue(), { serverInstanceId: 'server-a', version: 99 }),
		);

		expect(store.getExecutionControl('chat-a')).toBeNull();
		expect(store.getExecutionControl('chat-b')?.serverInstanceId).toBe('server-b');
		warn.mockRestore();
	});

	it('accepts a lower version when an unseen provisional instance replaces the old process', () => {
		const store = new ConversationUiState();
		store.confirmExecutionControlSocketInstance('server-a');
		store.setExecutionControlFromLiveUpdate(
			'chat-a',
			makeControl(makeQueue(), {
				serverInstanceId: 'server-a',
				version: 9,
			}),
		);
		store.markExecutionControlSocketDisconnected();
		const replacement = makeControl(makeQueue({ entries: [makeEntry('new', 'new')] }), {
			serverInstanceId: 'server-b',
			version: 1,
		});

		store.setExecutionControlFromRefresh('chat-a', replacement);

		expect(store.getExecutionControl('chat-a')).toEqual(replacement);
	});

	it('rejects delayed superseded input and logs only reconciliation metadata', () => {
		const store = new ConversationUiState();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		store.confirmExecutionControlSocketInstance('server-a');
		store.markExecutionControlSocketDisconnected();
		const current = makeControl(makeQueue({ entries: [makeEntry('current', 'secret')] }), {
			serverInstanceId: 'server-b',
			version: 1,
		});
		store.setExecutionControlFromLiveUpdate('chat-b', current);

		store.setExecutionControlFromLiveUpdate(
			'chat-a',
			makeControl(makeQueue(), {
				serverInstanceId: 'server-a',
				version: 99,
			}),
		);

		expect(store.getExecutionControl('chat-b')).toEqual(current);
		expect(store.getExecutionControl('chat-a')).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			'[ConversationUiState] Rejected execution control instance',
			expect.objectContaining({
				reason: 'superseded-instance',
				incomingInstanceId: 'server-a',
				currentInstanceId: 'server-b',
			}),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
		warn.mockRestore();
	});

	it('rejects every differing instance while the socket is confirmed', () => {
		const store = new ConversationUiState();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		store.confirmExecutionControlSocketInstance('server-b');
		const current = makeControl(makeQueue(), { serverInstanceId: 'server-b', version: 1 });
		store.setExecutionControlFromLiveUpdate('chat-a', current);

		store.setExecutionControlFromRefresh(
			'chat-a',
			makeControl(makeQueue(), {
				serverInstanceId: 'server-c',
				version: 99,
			}),
		);

		expect(store.getExecutionControl('chat-a')).toEqual(current);
		expect(warn).toHaveBeenCalledWith(
			'[ConversationUiState] Rejected execution control instance',
			expect.objectContaining({ reason: 'confirmed-socket-mismatch' }),
		);
		warn.mockRestore();
	});

	it('keeps ordinary same-instance stale-version rejection silent', () => {
		const store = new ConversationUiState();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const current = makeControl(makeQueue(), { version: 5 });
		store.setExecutionControlFromLiveUpdate('chat-a', current);

		store.setExecutionControlFromLiveUpdate('chat-a', makeControl(makeQueue(), { version: 4 }));
		store.setExecutionControlFromRefresh('chat-a', makeControl(makeQueue(), { version: 5 }));

		expect(store.getExecutionControl('chat-a')).toEqual(current);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
