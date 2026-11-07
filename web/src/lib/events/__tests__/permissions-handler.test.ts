import { describe, expect, it, vi } from 'vitest';
import { BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import type { ChatTransientFeedSnapshot, TransientFeedRow } from '$shared/chat-transient-feed';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { syncPermissionWaitingStatus } from '../handlers/permissions.js';

const identity = { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1' };
function permission(id: string): TransientFeedRow {
	return {
		permissionOccurrenceId: id,
		runId: 'run-1', displayOrder: 0,
		transcript: { transcriptViewId: identity.transcriptViewId, afterOrdinal: 10 },
		message: new PermissionRequestMessage('2026-01-01T00:00:00.000Z', id,
			new BashToolUseMessage('2026-01-01T00:00:00.000Z', 'tool-1', 'pwd'), 'Synthetic permission reason'),
	};
}
function fixture(rows: TransientFeedRow[] = []) {
	const ui = new ConversationUiState();
	ui.activateTransientFeed(identity.chatId);
	ui.setTransientFeedFromSnapshot({ ...identity, transientRevision: 1, rows } satisfies ChatTransientFeedSnapshot);
	const status = new ConversationLifecycleState();
	const lifecycle = { pushLoadingStatus: vi.fn((_chatId, entry) => status.pushLoadingStatus(entry)),
		popLoadingStatus: vi.fn((_chatId, id) => status.popLoadingStatus(id)) } satisfies Parameters<typeof syncPermissionWaitingStatus>[2];
	return { ui, lifecycle, status, sync: () => syncPermissionWaitingStatus(identity.chatId, ui, lifecycle) };
}

describe('permission waiting status from authoritative transient controls', () => {
	it('preserves the reason and waits for a live permission without resident history', () => {
		const test = fixture([permission('permission-1')]);
		test.sync();
		expect(test.ui.pendingPermissionsFor('chat-1')[0].reason).toBe('Synthetic permission reason');
		expect(test.lifecycle.pushLoadingStatus).toHaveBeenCalledWith('chat-1', expect.objectContaining({ id: 'WAITING_FOR_PERMISSION' }));
		expect(test.status.loadingStatusStack).toHaveLength(1);
	});

	it('uses one waiting status for concurrent permissions and retains it until the last removal', () => {
		const test = fixture([permission('permission-1'), permission('permission-2')]);
		test.sync();
		expect(test.lifecycle.pushLoadingStatus).toHaveBeenCalledTimes(1);
		test.sync();
		expect(test.status.loadingStatusStack).toHaveLength(1);
		test.ui.applyTransientFeedMutation({ ...identity, transientRevision: 2, mutation: { kind: 'remove', permissionOccurrenceId: 'permission-1' } });
		test.sync();
		expect(test.status.loadingStatusStack).toHaveLength(1);
		expect(test.ui.pendingPermissionsFor('chat-1').map(request => request.permissionOccurrenceId)).toEqual(['permission-2']);
		test.ui.applyTransientFeedMutation({ ...identity, transientRevision: 3, mutation: { kind: 'remove', permissionOccurrenceId: 'permission-2' } });
		test.sync();
		expect(test.lifecycle.popLoadingStatus).toHaveBeenCalledWith('chat-1', 'WAITING_FOR_PERMISSION');
		expect(test.status.loadingStatusStack).toEqual([]);
	});

	it('ignores a stale removal and deduplicates a repeated upsert', () => {
		const row = permission('permission-1');
		const test = fixture([row]);
		test.ui.applyTransientFeedMutation({ ...identity, transientRevision: 2, mutation: { kind: 'upsert', row } });
		test.ui.applyTransientFeedMutation({ ...identity, transientRevision: 1, mutation: { kind: 'remove', permissionOccurrenceId: row.permissionOccurrenceId } });
		test.sync();
		expect(test.ui.pendingPermissionsFor('chat-1')).toHaveLength(1);
		expect(test.status.loadingStatusStack).toHaveLength(1);
	});

	it('does not treat historical or presentation-only requests as live capabilities', () => {
		const test = fixture();
		test.ui.updatePendingPermissionsForChat('chat-1', [{
			permissionOccurrenceId: 'historical', requestedTool: permission('historical').message.requestedTool,
		}]);
		test.sync();
		expect(test.lifecycle.pushLoadingStatus).not.toHaveBeenCalled();
		expect(test.lifecycle.popLoadingStatus).toHaveBeenCalledWith('chat-1', 'WAITING_FOR_PERMISSION');
	});

	it('keeps background waiting status scoped to its own chat', () => {
		const test = fixture([permission('permission-1')]);
		test.ui.activateTransientFeed('chat-2');
		test.sync();
		expect(test.lifecycle.pushLoadingStatus).toHaveBeenCalledWith('chat-1', expect.objectContaining({ id: 'WAITING_FOR_PERMISSION' }));
		expect(test.ui.pendingPermissionRequests).toEqual([]);
	});
});
