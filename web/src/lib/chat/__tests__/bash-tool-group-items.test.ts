import { describe, expect, it } from 'vitest';
import { BashToolUseMessage } from '$shared/chat-types';
import { buildBashToolGroupRenderItems } from '../bash-tool-group-items';

const TS = '2026-05-29T00:00:00.000Z';

describe('buildBashToolGroupRenderItems', () => {
	it('keeps duplicate tool IDs from producing duplicate Svelte keys', () => {
		const messages = [
			new BashToolUseMessage(TS, 'duplicate-tool', 'pwd'),
			new BashToolUseMessage(TS, 'duplicate-tool', 'ls'),
		];

		const items = buildBashToolGroupRenderItems(messages);

		expect(items.map((item) => item.key)).toEqual(['duplicate-tool', 'duplicate-tool#1']);
		expect(items.map((item) => item.message.command)).toEqual(['pwd', 'ls']);
	});

	it('keeps existing keys stable when commands append to the group', () => {
		const first = [
			new BashToolUseMessage(TS, 'duplicate-tool', 'pwd'),
			new BashToolUseMessage(TS, 'duplicate-tool', 'ls'),
		];
		const second = [...first, new BashToolUseMessage(TS, 'duplicate-tool', 'git status')];

		const firstKeys = buildBashToolGroupRenderItems(first).map((item) => item.key);
		const secondKeys = buildBashToolGroupRenderItems(second).map((item) => item.key);

		expect(secondKeys.slice(0, firstKeys.length)).toEqual(firstKeys);
		expect(secondKeys[2]).toBe('duplicate-tool#2');
	});
});
