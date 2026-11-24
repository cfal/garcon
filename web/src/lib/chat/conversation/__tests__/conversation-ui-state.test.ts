import { describe, expect, it, vi } from 'vitest';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import type {
	ChatExecutionControlState,
	ChatQueueState,
	PendingPermissionRequest,
	QueueEntry,
} from '$lib/types/chat';
import {
	BashToolUseMessage,
	ExitPlanModeToolUseMessage,
	PermissionRequestMessage,
} from '$shared/chat-types';
import type { ChatTransientFeedSnapshot } from '$shared/chat-transient-feed';
import { tick } from 'svelte';
import { mountConversationUiPruning } from './conversation-ui-state-effect-harness.svelte.js';

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

function makeEntry(id: string, content: string, revision = 1): QueueEntry {
	return {
		id,
		content,
		kind: 'turn',
		attachments: [],
		revision,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

function makePermissionRequest(id: string, chatId: string | null = null): PendingPermissionRequest {
	return {
		permissionOccurrenceId: `incarnation-${id}`,
		requestedTool: new BashToolUseMessage('2026-07-15T00:00:00.000Z', `tool-${id}`, 'echo test'),
		chatId,
	};
}

function makeExitPlanRequest(id: string): PendingPermissionRequest {
	return {
		permissionOccurrenceId: id,
		requestedTool: new ExitPlanModeToolUseMessage(
			'2026-07-15T00:00:00.000Z',
			`tool-${id}`,
			'Implement the plan.',
		),
	};
}

function makeTransientFeed(chatId: string): ChatTransientFeedSnapshot {
	const requestedTool = new BashToolUseMessage(
		'2026-07-15T00:00:00.000Z',
		'tool-live',
		'echo live',
	);
	return {
		serverInstanceId: 'server-instance-test',
		chatId,
		transcriptViewId: 'view-live',
		transientRevision: 1,
		rows: [
			{
				permissionOccurrenceId: 'permission-live',
				runId: 'run-live',
				transcript: { transcriptViewId: 'view-live', afterOrdinal: 4 },
				displayOrder: 4,
				message: new PermissionRequestMessage(
					'2026-07-15T00:00:00.000Z',
					'permission-live',
					requestedTool,
				),
			},
		],
	};
}

describe('ConversationUiState', () => {
	it('replaces only predecessor-owned plan controls when a successor feed is installed', () => {
		const ui = new ConversationUiState();
		ui.setTransientFeedFromSnapshot({ ...makeTransientFeed('chat'), transcriptViewId: 'view-old', rows: [] });
		ui.beginPlanModeForChat('chat', 'default', 'view-old');
		ui.updatePendingPermissionsForChat('chat', ['view-old', 'view-live'].map(view => ({
			...makeExitPlanRequest(view), transcript: { transcriptViewId: view, afterOrdinal: 1 },
		})));
		ui.setTransientFeedFromSnapshot(makeTransientFeed('chat'));
		expect(ui.pendingPermissionsFor('chat').map(request => request.permissionOccurrenceId)).toEqual(['view-live', 'permission-live']);
		expect(ui.previousPermissionModeFor('chat')).toBeNull();
		ui.beginPlanModeForChat('chat', 'acceptEdits', 'view-live');
		ui.retirePlanModeForView('chat', 'view-old');
		expect(ui.pendingPermissionsFor('chat').map(request => request.permissionOccurrenceId)).toEqual(['view-live', 'permission-live']);
		expect(ui.previousPermissionModeFor('chat')).toBe('acceptEdits');
	});

	it('fences delayed HTTP transient snapshots against newer execution authority', () => {
		const changed = vi.fn();
		const ui = new ConversationUiState(changed);
		ui.confirmExecutionControlSocketInstance('first');
		const response = ui.captureExecutionResponse();
		ui.markExecutionControlSocketDisconnected();
		const current = makeControl(makeQueue(), { serverInstanceId: 'third', version: 2 });
		ui.setExecutionControlFromRefresh('chat', current);
		changed.mockClear();
		expect(response.setTransientFeedFromSnapshot({ ...makeTransientFeed('chat'), serverInstanceId: 'second' })).toEqual({ kind: 'stale' });
		expect(ui.getExecutionControl('chat')).toEqual(current);
		expect(changed).not.toHaveBeenCalled();
		response.setExecutionControlFromLiveUpdate('chat', { ...current, version: 3 });
		response.setExecutionControlFromRefresh('chat', current);
		expect(ui.getExecutionControl('chat')?.version).toBe(3);
	});

	it.each(['replacement', 'removal'] as const)('fences captured transient responses after feed %s', change => {
		const ui = new ConversationUiState();
		const initial = makeTransientFeed('chat');
		ui.setTransientFeedFromSnapshot(initial);
		const response = ui.captureExecutionResponse();
		const current = { ...initial, transcriptViewId: 'view-current', rows: [] };
		if (change === 'replacement') ui.setTransientFeedFromSnapshot(current);
		else ui.removeTransientFeed('chat');
		expect(response.setTransientFeedFromSnapshot(initial)).toEqual({ kind: 'stale' });
		expect(ui.getTransientFeed('chat')).toEqual(change === 'replacement' ? current : null);
	});

	it.each([false, true])('orders concurrent same-view responses by revision (newer first: %s)', newerFirst => {
		const ui = new ConversationUiState();
		const older = ui.captureExecutionResponse();
		const newer = ui.captureExecutionResponse();
		const initial = { ...makeTransientFeed('chat'), rows: [] };
		const current = { ...makeTransientFeed('chat'), transientRevision: 2 };
		const applyOlder = () => older.setTransientFeedFromSnapshot(initial);
		const applyNewer = () => newer.setTransientFeedFromSnapshot(current);
		if (newerFirst) { applyNewer(); applyOlder(); }
		else { applyOlder(); applyNewer(); }
		expect(ui.getTransientFeed('chat')).toEqual(current);
		expect(ui.pendingPermissionsFor('chat').map(request => request.permissionOccurrenceId)).toEqual(['permission-live']);
	});

	it.each([false, true])('accepts a successor feed without comparing predecessor views (confirmed: %s)', confirmed => {
		const ui = new ConversationUiState();
		ui.setTransientFeedFromSnapshot(makeTransientFeed('chat'));
		const response = ui.captureExecutionResponse();
		ui.markExecutionControlSocketDisconnected();
		if (confirmed) ui.confirmExecutionControlSocketInstance('successor');
		const current = { ...makeTransientFeed('chat'), serverInstanceId: 'successor', transcriptViewId: 'view-current', rows: [] };
		expect(response.setTransientFeedFromSnapshot(current)).toMatchObject({ kind: 'applied' });
		expect(ui.getTransientFeed('chat')).toEqual(current);
	});

	it('does not replay a rejected queued acknowledgement after later socket confirmation', () => {
		const ui = new ConversationUiState();
		ui.confirmExecutionControlSocketInstance('previous');
		const response = ui.captureExecutionResponse();
		const ack = makeControl(makeQueue({ entries: [makeEntry('own', 'guidance')] }), { serverInstanceId: 'successor' });
		response.setExecutionControlFromLiveUpdate('chat', ack);
		expect(ui.getExecutionControl('chat')).toBeNull();
		ui.markExecutionControlSocketDisconnected();
		ui.confirmExecutionControlSocketInstance('successor');
		expect(ui.getExecutionControl('chat')).toBeNull();
		ui.captureExecutionResponse().setExecutionControlFromRefresh('chat', ack);
		expect(ui.getExecutionControl('chat')).toEqual(ack);
	});

	it('does not let a delayed intermediate acknowledgement clear a later process while the socket is down', () => {
		const changed = vi.fn();
		const ui = new ConversationUiState(changed);
		ui.confirmExecutionControlSocketInstance('first');
		const response = ui.captureExecutionResponse();
		ui.markExecutionControlSocketDisconnected();
		const current = makeControl(makeQueue({ entries: [makeEntry('own', 'guidance')] }), { serverInstanceId: 'third' });
		ui.setExecutionControlFromRefresh('chat', current);
		changed.mockClear();
		response.setExecutionControlFromLiveUpdate('chat', makeControl(makeQueue(), { serverInstanceId: 'second' }));
		expect(ui.getExecutionControl('chat')).toEqual(current);
		expect(changed).not.toHaveBeenCalled();
	});

	it('does not remove a control installed after a not-found request started', () => {
		const ui = new ConversationUiState();
		ui.setExecutionControlFromRefresh('chat', makeControl());
		const remove = ui.captureExecutionControlRemoval('chat');
		const current = makeControl(makeQueue({ entries: [makeEntry('own', 'guidance')] }), { version: 1 });
		ui.setExecutionControlFromLiveUpdate('chat', current);
		expect(remove()).toBe(false);
		expect(ui.getExecutionControl('chat')).toEqual(current);
		expect(ui.captureExecutionControlRemoval('chat')()).toBe(true);
		expect(ui.getExecutionControl('chat')).toBeNull();
	});

	it('notifies queue projections only for accepted controls and authoritative removal', () => {
		const changed = vi.fn();
		const ui = new ConversationUiState(changed);
		const newer = makeControl(makeQueue(), { version: 2 });
		ui.setExecutionControlFromRefresh('chat-1', newer);
		ui.setExecutionControlFromLiveUpdate('chat-1', makeControl());
		ui.setExecutionControlFromRefresh('chat-1', makeControl());
		ui.markExecutionControlSocketDisconnected();
		expect(changed.mock.calls).toEqual([['chat-1', newer]]);
		ui.confirmExecutionControlSocketInstance('replacement');
		expect(changed.mock.calls).toEqual([['chat-1', newer], ['chat-1', null]]);
	});
	it('updates pending permission requests through values or updater functions', () => {
		const store = new ConversationUiState();
		const first = makePermissionRequest('one');

		store.setPendingPermissionRequests([first]);
		store.setPendingPermissionRequests((previous) => [
			...previous,
			makePermissionRequest('two', 'chat-1'),
		]);

		expect(store.pendingPermissionRequests.map((request) => request.permissionOccurrenceId)).toEqual([
			'incarnation-one',
			'incarnation-two',
		]);

		store.clearPendingPermissionRequests();

		expect(store.pendingPermissionRequests).toEqual([]);
	});

	it('clears turn requests while preserving plan-exit decisions', () => {
		const store = new ConversationUiState();
		store.setPendingPermissionRequests([
			makePermissionRequest('tool-request'),
			makePermissionRequest('plan-exit-provider-collision'),
			makeExitPlanRequest('plan-exit-confirmation'),
		]);

		store.clearTurnPermissionRequests();

		expect(store.pendingPermissionRequests.map((request) => request.permissionOccurrenceId)).toEqual([
			'plan-exit-confirmation',
		]);
	});

	it('keeps permission projections independent by chat', () => {
		const store = new ConversationUiState();
		store.updatePendingPermissionsForChat('chat-a', [makePermissionRequest('a', 'chat-a')]);
		store.updatePendingPermissionsForChat('chat-b', [
			makePermissionRequest('b', 'chat-b'),
			makeExitPlanRequest('plan-exit-b'),
		]);

		store.clearTurnPermissionRequestsForChat('chat-b');

		expect(store.pendingPermissionsFor('chat-a').map((request) => request.chatId)).toEqual([
			'chat-a',
		]);
		expect(
			store.pendingPermissionsFor('chat-b').map((request) => request.permissionOccurrenceId),
		).toEqual(['plan-exit-b']);
		expect(store.pendingPermissionChatIds.sort()).toEqual(['chat-a', 'chat-b']);
	});

	it('projects compatibility permissions from the activated chat', () => {
		const store = new ConversationUiState();
		store.updatePendingPermissionsForChat('chat-a', [makePermissionRequest('a', 'chat-a')]);
		store.updatePendingPermissionsForChat('chat-b', [makePermissionRequest('b', 'chat-b')]);

		store.activateTransientFeed('chat-b');

		expect(store.pendingPermissionRequests.map((request) => request.chatId)).toEqual(['chat-b']);
	});

	it('retains plan-mode restoration independently by chat', () => {
		const store = new ConversationUiState();
		store.beginPlanModeForChat('chat-a', 'default');
		store.beginPlanModeForChat('chat-b', 'acceptEdits');
		store.beginPlanModeForChat('chat-a', 'bypassPermissions');

		expect(store.previousPermissionModeFor('chat-a')).toBe('default');
		expect(store.previousPermissionModeFor('chat-b')).toBe('acceptEdits');
		expect(store.finishPlanModeForChat('chat-a')).toBe('default');
		expect(store.previousPermissionModeFor('chat-a')).toBeNull();
		expect(store.previousPermissionModeFor('chat-b')).toBe('acceptEdits');
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

	it('retains live transient controls while chat-list hydration is pending', async () => {
		const store = new ConversationUiState();
		expect(store.setTransientFeedFromSnapshot(makeTransientFeed('chat-live'))).toMatchObject({
			kind: 'applied',
		});

		const cleanup = mountConversationUiPruning(store, () => new Set());
		await tick();

		expect(store.transientFeedChatIds).toEqual(['chat-live']);
		expect(store.pendingPermissionsFor('chat-live')).toMatchObject([
			{
				permissionOccurrenceId: 'permission-live',
				control: { chatId: 'chat-live', permissionOccurrenceId: 'permission-live' },
			},
		]);
		cleanup();
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
