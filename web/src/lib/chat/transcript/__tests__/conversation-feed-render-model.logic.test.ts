import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	AskUserQuestionToolUseMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	CommandOutputMessage,
	CommandResultMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	ToolResultMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { ConversationFeedRenderModelController } from '../conversation-feed-render-model.js';
import { buildConversationFeedRenderModel } from '../conversation-feed-items.js';
import type { ChatDisplayRow } from '../active-transcript-state.svelte.js';

const TS = '2026-08-03T00:00:00.000Z';

function row(ordinal: number, message: ChatMessage): Extract<ChatDisplayRow, { kind: 'message' }> {
	return { kind: 'message', id: `generation-1:${ordinal}`, ordinal, message };
}

describe('ConversationFeedRenderModelController', () => {
	it.each(['wrapper-first', 'use-first'])('matches full rebuilds across FIFO tools and %s permissions', (order) => {
		const question = new AskUserQuestionToolUseMessage(TS, 'shared-question', undefined, []);
		const wrapper = new PermissionRequestMessage(TS, 'permission', question);
		const source: ChatMessage[] = [
			...(order === 'wrapper-first' ? [wrapper, question] : [question, wrapper]),
			new ReadToolUseMessage(TS, 'duplicate', '/a'),
			new ReadToolUseMessage(TS, 'duplicate', '/b'),
			new AssistantMessage(TS, 'interleaved'),
			new ToolResultMessage(TS, 'duplicate', { raw: 'first' }, false),
			new PermissionResolvedMessage(TS, 'permission', true),
			new ToolResultMessage(TS, 'shared-question', { raw: 'answer' }, false),
			new ToolResultMessage(TS, 'duplicate', { raw: 'second' }, false),
		];
		const controller = new ConversationFeedRenderModelController();
		const entries: ChatDisplayRow[] = [];
		for (const [index, message] of source.entries()) {
			const previous = controller.reconcile('surface', [...entries]);
			const previousResults = new Map(previous.toolResultByUseRowId);
			const previousResultRows = new Map(previous.toolResultRowIdByUseRowId);
			const previousTerminals = new Map(previous.permissionTerminalByOccurrence);
			entries.push(row(index + 1, message));
			const actual = controller.reconcileDetailed('surface', [...entries]);
			expect(actual.change.kind).toBe('tail-appended');
			expect(actual.model).toEqual(buildConversationFeedRenderModel(entries));
			expect(previous.toolResultByUseRowId).toEqual(previousResults);
			expect(previous.toolResultRowIdByUseRowId).toEqual(previousResultRows);
			expect(previous.permissionTerminalByOccurrence).toEqual(previousTerminals);
			for (const [itemIndex, item] of previous.items.entries()) {
				expect(actual.model.items[itemIndex]).toBe(item);
			}
		}
	});

	it.each([false, true])('refreshes delivery state when an append is %s', (append) => {
		const controller = new ConversationFeedRenderModelController();
		const message = new UserMessage(TS, 'Synthetic pending input');
		const pending: ChatDisplayRow = { ...row(1, message), awaitingDelivery: true };
		const previous = controller.reconcile('surface', [pending]);
		const delivered = row(1, message);
		const rows = append ? [delivered, row(2, new AssistantMessage(TS, 'Delivered'))] : [delivered];
		const actual = controller.reconcileDetailed('surface', rows);
		expect(actual.change.kind).toBe('rebuilt');
		expect(actual.model).toEqual(buildConversationFeedRenderModel(rows));
		expect(actual.model.items[0]).not.toHaveProperty('awaitingDelivery');
		expect(previous.items[0]).toHaveProperty('awaitingDelivery', true);
	});

	it.each(['prepend', 'replacement', 'surface', 'reset'])('resets FIFO pairing after %s', (transition) => {
		const controller = new ConversationFeedRenderModelController();
		const oldUse = row(2, new ReadToolUseMessage(TS, 'reused-tool', '/old'));
		const previous = controller.reconcile('surface', [oldUse]);
		const newUse = row(1, new ReadToolUseMessage(TS, 'reused-tool', '/new'));
		const rows = transition === 'prepend' ? [newUse, oldUse] : [newUse];
		const surface = transition === 'surface' ? 'replacement-surface' : 'surface';
		if (transition === 'reset') controller.reset();
		expect(controller.reconcileDetailed(surface, rows).change.kind).toBe('rebuilt');
		const result = new ToolResultMessage(TS, 'reused-tool', { raw: 'Synthetic result' }, false);
		const appended = [...rows, row(3, result)];
		const actual = controller.reconcileDetailed(surface, appended);
		expect(actual.change.kind).toBe('tail-appended');
		expect(actual.model).toEqual(buildConversationFeedRenderModel(appended));
		expect(actual.model.toolResultByUseRowId.get(newUse.id)).toBe(result);
		expect(actual.model.toolResultByUseRowId.has(oldUse.id)).toBe(false);
		expect(previous.toolResultByUseRowId.size).toBe(0);
	});

	it('does not read old tool identifiers again on an ordinary append', () => {
		let reads = 0;
		const tool = new ReadToolUseMessage(TS, 'old', '/a');
		Object.defineProperty(tool, 'toolId', { get: () => { reads++; return 'old'; } });
		const first = row(1, tool);
		const controller = new ConversationFeedRenderModelController();
		const previous = controller.reconcile('surface', [first]);
		reads = 0;
		const next = controller.reconcile('surface', [first, row(2, new AssistantMessage(TS, 'next'))]);
		expect(reads).toBe(0);
		expect(next.items[0]).toBe(previous.items[0]);
		expect(previous.items).toHaveLength(1);
	});

	it('rebuilds prior output when a complete result makes Markdown eligible', () => {
		const controller = new ConversationFeedRenderModelController();
		const context = { executorId: 'local', projectPath: '/project' };
		const first = row(1, new CommandOutputMessage(TS, 'command-1', 'stdout', 'markdown', '# first', context));
		const initial = controller.reconcile('surface', [first]);
		expect(initial.items[0]).toMatchObject({ message: { format: 'plain' } });
		const next = controller.reconcileDetailed('surface', [first,
			row(2, new CommandResultMessage(TS, 'command-1', { outcome: 'finished', exitCode: 0, signal: null,
				capture: 'complete', cwd: { kind: 'reported', path: '/project' } }))]);
		expect(next.change.kind).toBe('rebuilt');
		expect(next.model.items[0]).toMatchObject({ id: first.id, message: { content: '# first', format: 'markdown' } });
		expect(initial.items[0]).toMatchObject({ message: { format: 'plain' } });
	});

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

	it('[TLV5-L02.03-WEB-UNIT-01] keeps distinct identical assistant messages because their row ids differ', () => {
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
