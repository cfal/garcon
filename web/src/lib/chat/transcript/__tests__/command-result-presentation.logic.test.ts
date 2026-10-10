import { describe, expect, it } from 'vitest';
import { CommandOutputMessage, CommandResultMessage, UserMessage } from '$shared/chat-types';
import type { CommandOutcome } from '$shared/command-output.js';
import type { ChatDisplayRow } from '../transcript-row-projection.js';
import { commandResultPresentation } from '../command-result-presentation.js';
import { buildConversationFeedRenderModel, conversationFeedItemLayout } from '../conversation-feed-items.js';
import { ConversationFeedRenderModelController } from '../conversation-feed-render-model.js';

const at = '2026-01-01T00:00:00.000Z';
const complete: CommandOutcome = {
	outcome: 'finished', exitCode: 0, signal: null, capture: 'complete',
	cwd: { kind: 'reported', path: '/workspace' },
};
const failed = new CommandResultMessage(at, 'command-1', { ...complete, outcome: 'failed', exitCode: 127 });
const resultRow: ChatDisplayRow = { kind: 'message', id: 'view:3', ordinal: 3, message: failed };
const notice: ChatDisplayRow = { kind: 'local-notice', id: 'notice-1', noticeType: 'error', content: failed.content, timestamp: at };

function layouts(rows: ChatDisplayRow[]) {
	return buildConversationFeedRenderModel(rows).items.map(conversationFeedItemLayout);
}

describe('command result presentation', () => {
	it('hides only clean completion and retains failure diagnostics', () => {
		expect(commandResultPresentation(complete)).toBe('hidden');
		expect(commandResultPresentation(failed.result)).toBe('error');
		const warnings: Partial<CommandOutcome>[] = [
			{ outcome: 'interrupted' }, { outcome: 'unknown' }, { signal: 'SIGTERM' },
			{ exitCode: null }, { exitCode: 1 }, { capture: 'truncated' }, { capture: 'incomplete' },
			{ cwd: { kind: 'unavailable', reason: 'Unreadable report' } },
		];
		for (const warning of warnings) expect(commandResultPresentation({ ...complete, ...warning })).toBe('warning');
	});

	it('keeps hidden completion evidence for Markdown and preserves durable identity', () => {
		const output = new CommandOutputMessage(at, 'command-1', 'stdout', 'markdown', '**output**',
			{ executorId: 'local', projectPath: '/workspace' });
		const result = { ...resultRow, message: new CommandResultMessage(at, 'command-1', complete) };
		const model = buildConversationFeedRenderModel([
			{ kind: 'message', id: 'view:2', ordinal: 2, message: output }, result,
		]);
		expect(model.items[0]).toMatchObject({ message: { format: 'markdown' } });
		expect(model.items[1]).toMatchObject(result);
		expect(model.items.map(conversationFeedItemLayout)).toEqual(['standard', 'hidden']);
	});

	it('hides one matching tail notice, not the durable result or a distinct error', () => {
		expect(layouts([resultRow, notice])).toEqual(['standard', 'hidden']);
		expect(layouts([resultRow, notice, { ...notice, id: 'notice-2' }])).toEqual(['standard', 'hidden', 'standard']);
		expect(layouts([resultRow, { ...notice, content: 'Cwd persistence failed' }, notice])).toEqual(['standard', 'standard', 'standard']);
		expect(layouts([notice])).toEqual(['standard']);
		expect(layouts([resultRow])).toEqual(['standard']);
	});

	it('does not match an earlier failure across new input or collapse identical commands', () => {
		const nextInput: ChatDisplayRow = { kind: 'message', id: 'view:4', message: new UserMessage(at, 'missing-command') };
		expect(layouts([resultRow, nextInput, notice])).toEqual(['standard', 'standard', 'standard']);
		const second = { ...resultRow, id: 'view:5', message: new CommandResultMessage(at, 'command-2', failed.result) };
		expect(layouts([resultRow, nextInput, second, notice])).toEqual(['standard', 'standard', 'standard', 'hidden']);
	});

	it('rebuilds if newly loaded evidence changes a notice disposition', () => {
		const controller = new ConversationFeedRenderModelController();
		controller.reconcile('surface', [notice]);
		const loaded = controller.reconcileDetailed('surface', [resultRow, notice]);
		expect(loaded.change.kind).toBe('rebuilt');
		expect(loaded.model.items.map(conversationFeedItemLayout)).toEqual(['standard', 'hidden']);
		const appended = controller.reconcileDetailed('surface', [resultRow, notice,
			{ kind: 'message', id: 'view:4', message: new UserMessage(at, 'next') }]);
		expect(appended.change.kind).toBe('rebuilt');
		expect(appended.model.items.map(conversationFeedItemLayout)).toEqual(['standard', 'standard', 'standard']);
	});
});
