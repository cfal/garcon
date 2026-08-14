import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	ToolResultMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { ConversationFeedRenderModelController } from '../conversation-feed-render-model.js';
import type { ChatDisplayRow } from '../active-transcript-state.svelte.js';

const TS = '2026-08-03T00:00:00.000Z';

function row(ordinal: number, message: ChatMessage): ChatDisplayRow {
	return { kind: 'message', id: `generation-1:${seq}`, seq, message };
}

describe('ConversationFeedRenderModelController', () => {
	it('publishes streamed message and tool rows once in exact transcript order', () => {
		const controller = new ConversationFeedRenderModelController();
		const source = [
			row(1, new UserMessage(TS, 'run this')),
			row(2, new AssistantMessage(TS, 'I will inspect it.')),
			row(3, new BashToolUseMessage(TS, 'bash-1', 'pwd')),
			row(4, new ToolResultMessage(TS, 'bash-1', { content: '/tmp' }, false)),
			row(5, new AssistantMessage(TS, 'The first result is ready.')),
			row(6, new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts')),
			row(7, new BashToolUseMessage(TS, 'bash-2', 'bun test')),
			row(8, new AssistantMessage(TS, 'Finished.')),
		];
		const expectedIds: string[][] = [
			['generation-1:1'],
			['generation-1:1', 'generation-1:2'],
			['generation-1:1', 'generation-1:2', 'generation-1:3'],
			['generation-1:1', 'generation-1:2', 'generation-1:3', 'generation-1:4'],
			['generation-1:1', 'generation-1:2', 'generation-1:3', 'generation-1:4', 'generation-1:5'],
			[
				'generation-1:1',
				'generation-1:2',
				'generation-1:3',
				'generation-1:4',
				'generation-1:5',
				'generation-1:6',
			],
			[
				'generation-1:1',
				'generation-1:2',
				'generation-1:3',
				'generation-1:4',
				'generation-1:5',
				'generation-1:6',
				'generation-1:7',
			],
			[
				'generation-1:1',
				'generation-1:2',
				'generation-1:3',
				'generation-1:4',
				'generation-1:5',
				'generation-1:6',
				'generation-1:7',
				'generation-1:8',
			],
		];

		for (let count = 1; count <= source.length; count += 1) {
			const reconciliation = controller.reconcileDetailed(
				'chat-1:generation-1',
				source.slice(0, count),
			);
			expect(reconciliation.model.items.map((item) => item.id)).toEqual(expectedIds[count - 1]);
			expect(new Set(reconciliation.model.items.map((item) => item.id)).size).toBe(
				reconciliation.model.items.length,
			);
		}
	});

	it('reports only individual tool and message rows as incremental appends', () => {
		const controller = new ConversationFeedRenderModelController();
		const user = row(1, new UserMessage(TS, 'start'));
		const bash = row(2, new BashToolUseMessage(TS, 'bash-1', 'pwd'));
		const result = row(3, new ToolResultMessage(TS, 'bash-1', { content: '/tmp' }, false));
		const assistant = row(4, new AssistantMessage(TS, 'done'));

		expect(controller.reconcileDetailed('surface', [user]).change.kind).toBe('rebuilt');
		expect(controller.reconcileDetailed('surface', [user, bash]).change).toMatchObject({
			kind: 'tail-appended',
			appendedItems: [{ id: bash.id }],
		});
		expect(controller.reconcileDetailed('surface', [user, bash, result]).change).toMatchObject({
			kind: 'tail-appended',
			appendedItems: [{ id: result.id }],
		});
		expect(
			controller.reconcileDetailed('surface', [user, bash, result, assistant]).change,
		).toMatchObject({ kind: 'tail-appended', appendedItems: [{ id: assistant.id }] });
	});

	it('rebuilds an interior insertion without changing surviving row identity', () => {
		const controller = new ConversationFeedRenderModelController();
		const first = row(1, new AssistantMessage(TS, 'first'));
		const last = row(3, new AssistantMessage(TS, 'last'));
		controller.reconcile('surface', [first, last]);

		const inserted = row(2, new BashToolUseMessage(TS, 'bash-1', 'pwd'));
		const reconciliation = controller.reconcileDetailed('surface', [first, inserted, last]);

		expect(reconciliation.change.kind).toBe('rebuilt');
		expect(reconciliation.model.items.map((item) => item.id)).toEqual([
			first.id,
			inserted.id,
			last.id,
		]);
	});

	it('keeps distinct identical assistant messages because their row ids differ', () => {
		const controller = new ConversationFeedRenderModelController();
		const messages = [
			row(10, new AssistantMessage(TS, 'Standing by.')),
			row(11, new AssistantMessage(TS, 'Standing by.')),
		];

		const model = controller.reconcile('surface', messages);

		expect(model.items.map((item) => item.id)).toEqual(['generation-1:10', 'generation-1:11']);
		expect(model.items).toHaveLength(2);
	});

	it('reuses an unchanged model and rebuilds on a surface change', () => {
		const controller = new ConversationFeedRenderModelController();
		const messages = [row(1, new AssistantMessage(TS, 'one'))];
		const first = controller.reconcileDetailed('chat-1:generation-1', messages);
		const unchanged = controller.reconcileDetailed('chat-1:generation-1', messages);
		const switched = controller.reconcileDetailed('chat-2:generation-1', messages);

		expect(unchanged.change.kind).toBe('unchanged');
		expect(unchanged.model).toBe(first.model);
		expect(switched.change.kind).toBe('rebuilt');
		expect(switched.model.items.map((item) => item.id)).toEqual(['generation-1:1']);
	});
});
