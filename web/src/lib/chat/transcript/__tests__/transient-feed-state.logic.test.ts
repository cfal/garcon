import { describe, expect, it } from 'vitest';
import {
	BashToolUseMessage,
	PermissionRequestMessage,
} from '$shared/chat-types';
import type {
	ChatProjectionGenerationTransition,
	ChatTransientFeedMutation,
	ChatTransientFeedSnapshot,
	TransientFeedRow,
} from '$shared/chat-transient-feed';
import {
	applyProjectionGenerationTransition,
	applyTransientFeedMutation,
	applyTransientFeedSnapshot,
	pendingPermissionsFromTransientFeed,
} from '../transient-feed-state.js';

const owner = {
	agentOwnershipEpoch: 'owner-1',
	commandType: 'agent-run' as const,
	clientRequestId: 'request-1',
	turnId: 'turn-1',
};

function row(overrides: Partial<TransientFeedRow> = {}): TransientFeedRow {
	return {
		id: 'permission-1',
		incarnation: 'incarnation-1',
		operationTurnId: 'turn-1',
		turnOwner: owner,
		transcript: { generationId: 'generation-1', afterSeq: 3 },
		displayOrder: 0,
		message: new PermissionRequestMessage(
			'2026-08-11T00:00:00.000Z',
			'permission-1',
			new BashToolUseMessage('2026-08-11T00:00:00.000Z', 'tool-1', 'bun test'),
		),
		...overrides,
	};
}

function snapshot(overrides: Partial<ChatTransientFeedSnapshot> = {}): ChatTransientFeedSnapshot {
	return {
		serverInstanceId: 'server-1',
		chatId: 'chat-1',
		agentOwnershipEpoch: 'owner-1',
		generationId: 'generation-1',
		resetTransactionId: null,
		transientRevision: 1,
		stateDigest: 'digest-1',
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
		agentOwnershipEpoch: 'owner-1',
		generationId: 'generation-1',
		transientRevision: 2,
		stateDigest: 'digest-2',
		mutation: mutationBody,
		...overrides,
	};
}

describe('transient feed browser reducer', () => {
	it('does not resurrect a removed permission from a delayed duplicate upsert', () => {
		const removed = applyTransientFeedMutation(
			snapshot(),
			mutation({ kind: 'remove', id: 'permission-1', incarnation: 'incarnation-1' }),
		);
		expect(removed).toMatchObject({ kind: 'applied', snapshot: { rows: [] } });
		if (removed.kind !== 'applied') throw new Error('expected applied removal');

		const delayed = applyTransientFeedMutation(
			removed.snapshot,
			mutation(
				{ kind: 'upsert', row: row() },
				{ transientRevision: 1, stateDigest: 'digest-1' },
			),
		);
		expect(delayed).toEqual({ kind: 'stale' });
	});

	it('converges when an older HTTP snapshot and a compound WebSocket reset reorder', () => {
		const transition: ChatProjectionGenerationTransition = {
			resetTransactionId: 'reset-1',
			serverInstanceId: 'server-1',
			chatId: 'chat-1',
			agentOwnershipEpoch: 'owner-1',
			previousGenerationId: 'generation-1',
			generationId: 'generation-2',
			transientRevision: 2,
			stateDigest: 'digest-2',
			rows: [row({ transcript: { generationId: 'generation-2', afterSeq: 3 } })],
		};
		const transitioned = applyProjectionGenerationTransition(snapshot(), transition);
		expect(transitioned).toMatchObject({
			kind: 'applied',
			snapshot: { generationId: 'generation-2' },
		});
		if (transitioned.kind !== 'applied') throw new Error('expected transition');
		expect(applyTransientFeedSnapshot(transitioned.snapshot, snapshot())).toEqual({ kind: 'stale' });

		const resetSnapshot = snapshot({
			generationId: 'generation-2',
			resetTransactionId: 'reset-1',
			transientRevision: 2,
			stateDigest: 'digest-2',
			rows: transition.rows,
		});
		expect(applyProjectionGenerationTransition(resetSnapshot, transition)).toEqual({
			kind: 'duplicate',
		});
	});

	it('requires a snapshot for gaps and rejects contradictory equal revisions', () => {
		expect(applyTransientFeedMutation(
			snapshot(),
			mutation({ kind: 'upsert', row: row() }, { transientRevision: 3 }),
		)).toEqual({ kind: 'snapshot-required' });
		expect(applyTransientFeedMutation(
			snapshot(),
			mutation(
				{ kind: 'upsert', row: row() },
				{ transientRevision: 1, stateDigest: 'different' },
			),
		)).toEqual({ kind: 'corrupt' });
	});

	it('preserves one actionable permission through a generation transition', () => {
		const applied = applyProjectionGenerationTransition(snapshot(), {
			resetTransactionId: 'reset-1',
			serverInstanceId: 'server-1',
			chatId: 'chat-1',
			agentOwnershipEpoch: 'owner-1',
			previousGenerationId: 'generation-1',
			generationId: 'generation-2',
			transientRevision: 2,
			stateDigest: 'digest-2',
			rows: [row({ transcript: { generationId: 'generation-2', afterSeq: 3 } })],
		});
		if (applied.kind !== 'applied') throw new Error('expected transition');
		const permissions = pendingPermissionsFromTransientFeed(applied.snapshot);
		expect(permissions).toHaveLength(1);
		expect(permissions[0]?.control).toMatchObject({
			id: 'permission-1',
			incarnation: 'incarnation-1',
		});
		expect(permissions[0]?.transcript).toEqual({ generationId: 'generation-2', afterSeq: 3 });
	});

	it('accepts a new incarnation while rejecting a delayed prior removal', () => {
		const removed = applyTransientFeedMutation(
			snapshot(),
			mutation({ kind: 'remove', id: 'permission-1', incarnation: 'incarnation-1' }),
		);
		if (removed.kind !== 'applied') throw new Error('expected removal');
		const replacementRow = row({ incarnation: 'incarnation-2' });
		const replaced = applyTransientFeedMutation(
			removed.snapshot,
			mutation(
				{ kind: 'upsert', row: replacementRow },
				{ transientRevision: 3, stateDigest: 'digest-3' },
			),
		);
		if (replaced.kind !== 'applied') throw new Error('expected replacement');
		expect(applyTransientFeedMutation(
			replaced.snapshot,
			mutation(
				{ kind: 'remove', id: 'permission-1', incarnation: 'incarnation-1' },
				{ transientRevision: 2 },
			),
		)).toEqual({ kind: 'stale' });
	});
});
