import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { ConversationFeedRenderModelController } from '../conversation-feed-render-model.js';
import type { ChatDisplayRow } from '../active-transcript-state.svelte.js';

const TS = '2026-08-03T00:00:00.000Z';

function row(id: string, message: ChatMessage): ChatDisplayRow {
	return { kind: 'message', id, message };
}

function bash(id: string): ChatDisplayRow {
	return row(id, new BashToolUseMessage(TS, `tool-${id}`, id));
}

function read(id: string): ChatDisplayRow {
	return row(id, new ReadToolUseMessage(TS, `tool-${id}`, `/tmp/${id}`));
}

function separator(id: string): ChatDisplayRow {
	return row(id, new AssistantMessage(TS, id));
}

describe('ConversationFeedRenderModelController', () => {
	it('preserves one run key through singleton, group, and singleton transitions', () => {
		const controller = new ConversationFeedRenderModelController();
		const singleton = controller.reconcile('chat-1:generation-1', [bash('a')]);
		const key = singleton.items[0]?.virtualKey;

		const group = controller.reconcile('chat-1:generation-1', [bash('a'), bash('b')]);
		expect(group.items[0]?.virtualKey).toBe(key);
		expect(group.items[0]?.rowIds).toEqual(['a', 'b']);

		const trimmed = controller.reconcile('chat-1:generation-1', [bash('b')]);
		expect(trimmed.items[0]?.virtualKey).toBe(key);
		expect(trimmed.items[0]?.id).toBe('b');
	});

	it('gives a split run key to the fragment with the greatest overlap', () => {
		const controller = new ConversationFeedRenderModelController();
		const initial = controller.reconcile('chat-1:generation-1', [
			bash('a'),
			bash('b'),
			bash('c'),
			bash('d'),
		]);
		const key = initial.items[0]?.virtualKey;

		const split = controller.reconcile('chat-1:generation-1', [
			bash('a'),
			separator('separator'),
			bash('b'),
			bash('c'),
			bash('d'),
		]);
		const fragments = split.items.filter((item) => item.virtualKey === key);

		expect(fragments).toHaveLength(1);
		expect(fragments[0]?.rowIds).toEqual(['b', 'c', 'd']);
	});

	it('preserves runs independently across prepend and append changes', () => {
		const controller = new ConversationFeedRenderModelController();
		const initial = controller.reconcile('chat-1:generation-1', [read('b'), read('c')]);
		const key = initial.items[0]?.virtualKey;

		const expanded = controller.reconcile('chat-1:generation-1', [
			read('a'),
			read('b'),
			read('c'),
			read('d'),
		]);

		expect(expanded.items[0]?.virtualKey).toBe(key);
		expect(expanded.items[0]?.rowIds).toEqual(['a', 'b', 'c', 'd']);
	});

	it('resets run identity when the active transcript surface changes', () => {
		const controller = new ConversationFeedRenderModelController();
		controller.reconcile('chat-1:generation-1', [bash('a'), bash('b')]);
		const beforeSwitch = controller.reconcile('chat-1:generation-1', [bash('c'), bash('d')]);
		const afterSwitch = controller.reconcile('chat-2:generation-1', [bash('c'), bash('d')]);

		expect(beforeSwitch.items[0]?.virtualKey).not.toBe(afterSwitch.items[0]?.virtualKey);
		expect(afterSwitch.items[0]?.rowIds).toEqual(['c', 'd']);
		// The final virtual feed key adds the surface namespace; the reconciler
		// intentionally keeps run identity local to one resettable surface.
	});
});
