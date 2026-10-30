import { describe, expect, it, vi } from 'vitest';
import {
	handlePermissionFeedTransition,
	transientPermissionOccurrences,
	type PermissionLifecycleContext,
} from '../handlers/permissions';
import { BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import type { TransientFeedRow } from '$shared/chat-transient-feed';

function makeContext() {
	const ctx = {
		markTurnRunning: vi.fn(),
		pushLoadingStatus: vi.fn(),
		popLoadingStatus: vi.fn(),
	} satisfies PermissionLifecycleContext;
	return ctx;
}

function row(permissionOccurrenceId: string): TransientFeedRow {
	const at = '2026-08-15T00:00:00.000Z';
	return {
		permissionOccurrenceId,
		runId: 'run-1',
		transcript: { transcriptViewId: 'view-1', afterOrdinal: 1 },
		displayOrder: 0,
		message: new PermissionRequestMessage(
			at,
			permissionOccurrenceId,
			new BashToolUseMessage(at, 'tool-1', 'ls'),
		),
	};
}

describe('permission status from the transient feed', () => {
	it('reads the actionable occurrences of a feed', () => {
		expect([...transientPermissionOccurrences({ rows: [row('a'), row('b')] })]).toEqual(['a', 'b']);
		expect(transientPermissionOccurrences(null).size).toBe(0);
	});

	it('pushes waiting status for each newly actionable permission', () => {
		const ctx = makeContext();

		handlePermissionFeedTransition('chat-1', new Set(), new Set(['a', 'b']), ctx);

		expect(ctx.markTurnRunning).toHaveBeenCalledWith('chat-1');
		expect(ctx.pushLoadingStatus).toHaveBeenCalledTimes(2);
		expect(ctx.pushLoadingStatus).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ id: 'WAITING_FOR_PERMISSION', can_interrupt: true }),
		);
		expect(ctx.popLoadingStatus).not.toHaveBeenCalled();
	});

	it('pops waiting status only for occurrences that left the feed', () => {
		const ctx = makeContext();

		handlePermissionFeedTransition('chat-1', new Set(['a', 'b']), new Set(['b']), ctx);

		expect(ctx.popLoadingStatus).toHaveBeenCalledTimes(1);
		expect(ctx.popLoadingStatus).toHaveBeenCalledWith('chat-1', 'WAITING_FOR_PERMISSION');
		expect(ctx.pushLoadingStatus).not.toHaveBeenCalled();
	});

	it('does nothing when a repeated mutation leaves the feed unchanged', () => {
		const ctx = makeContext();

		handlePermissionFeedTransition('chat-1', new Set(['a']), new Set(['a']), ctx);

		expect(ctx.markTurnRunning).not.toHaveBeenCalled();
		expect(ctx.pushLoadingStatus).not.toHaveBeenCalled();
		expect(ctx.popLoadingStatus).not.toHaveBeenCalled();
	});
});
