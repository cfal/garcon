import { describe, expect, it } from 'vitest';
import { BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import type {
	ChatTransientFeedMutation,
	ChatTransientFeedSnapshot,
	TransientFeedRow,
} from '$shared/chat-transient-feed';
import {
	applyTransientFeedMutation,
	applyTransientFeedSnapshot,
	pendingPermissionsFromTransientFeed,
} from '../transient-feed-state.js';

function row(overrides: Partial<TransientFeedRow> = {}): TransientFeedRow {
	return {
		permissionOccurrenceId: 'incarnation-1',
		runId: 'run-1',
		transcript: { transcriptViewId: 'view-1', afterOrdinal: 3 },
		displayOrder: 0,
		message: new PermissionRequestMessage(
			'2026-08-11T00:00:00.000Z',
			'incarnation-1',
			new BashToolUseMessage('2026-08-11T00:00:00.000Z', 'tool-1', 'bun test'),
		),
		...overrides,
	};
}

function snapshot(overrides: Partial<ChatTransientFeedSnapshot> = {}): ChatTransientFeedSnapshot {
	return {
		serverInstanceId: 'server-1',
		chatId: 'chat-1',
		transcriptViewId: 'view-1',
		transientRevision: 1,
		rows: [row()],
		...overrides,
	};
}

function mutation(
	mutationBody: ChatTransientFeedMutation['mutation'],
	overrides: Partial<ChatTransientFeedMutation> = {},
): ChatTransientFeedMutation {
	return {
		serverInstanceId: 'server-1',
		chatId: 'chat-1',
		transcriptViewId: 'view-1',
		transientRevision: 2,
		mutation: mutationBody,
		...overrides,
	};
}

describe('transient feed browser reducer', () => {
	it('does not resurrect a removed permission from a delayed upsert', () => {
		const removed = applyTransientFeedMutation(
			snapshot(),
			mutation({ kind: 'remove', permissionOccurrenceId: 'incarnation-1' }),
		);
		expect(removed).toMatchObject({ kind: 'applied', snapshot: { rows: [] } });
		if (removed.kind !== 'applied') throw new Error('expected applied removal');

		expect(applyTransientFeedMutation(
			removed.snapshot,
			mutation({ kind: 'upsert', row: row() }, { transientRevision: 1 }),
		)).toEqual({ kind: 'stale' });
	});

	it('replaces overlay state when the transcript view changes', () => {
		const replacementRow = row({
			transcript: { transcriptViewId: 'view-2', afterOrdinal: 0 },
		});
		const replacement = snapshot({
			transcriptViewId: 'view-2',
			transientRevision: 0,
			rows: [replacementRow],
		});

		expect(applyTransientFeedSnapshot(snapshot(), replacement)).toEqual({
			kind: 'applied',
			snapshot: replacement,
		});
	});

	it('requires a snapshot for revision gaps or view-mismatched mutations', () => {
		expect(applyTransientFeedMutation(
			snapshot(),
			mutation({ kind: 'upsert', row: row() }, { transientRevision: 3 }),
		)).toEqual({ kind: 'snapshot-required' });
		expect(applyTransientFeedMutation(
			snapshot(),
			mutation({ kind: 'clear-run', runId: 'run-1' }, {
				transcriptViewId: 'view-2',
			}),
		)).toEqual({ kind: 'snapshot-required' });
	});

	it('projects an actionable permission with run and view fences', () => {
		const permissions = pendingPermissionsFromTransientFeed(snapshot());

		expect(permissions).toHaveLength(1);
		expect(permissions[0]?.control).toEqual({
			serverInstanceId: 'server-1',
			chatId: 'chat-1',
			runId: 'run-1',
			permissionOccurrenceId: 'incarnation-1',
		});
		expect(permissions[0]?.transcript).toEqual({
			transcriptViewId: 'view-1',
			afterOrdinal: 3,
		});
	});

	it('clears only rows belonging to the ended run', () => {
		const other = row({ permissionOccurrenceId: 'incarnation-2', runId: 'run-2' });
		const applied = applyTransientFeedMutation(
			snapshot({ rows: [row(), other] }),
			mutation({ kind: 'clear-run', runId: 'run-1' }),
		);

		expect(applied).toMatchObject({
			kind: 'applied',
			snapshot: { rows: [{ permissionOccurrenceId: 'incarnation-2', runId: 'run-2' }] },
		});
	});

	it('removes only the named permission occurrence', () => {
		const first = row();
		const second = row({
			permissionOccurrenceId: 'incarnation-2',
			displayOrder: 1,
			message: new PermissionRequestMessage(
				'2026-08-11T00:00:00.000Z',
				'incarnation-2',
				new BashToolUseMessage('2026-08-11T00:00:00.000Z', 'tool-2', 'bun test --watch'),
			),
		});
		const applied = applyTransientFeedMutation(
			snapshot({ rows: [first, second] }),
			mutation({ kind: 'remove', permissionOccurrenceId: 'incarnation-1' }),
		);

		expect(applied).toMatchObject({
			kind: 'applied',
			snapshot: { rows: [{ permissionOccurrenceId: 'incarnation-2' }] },
		});
	});
});
