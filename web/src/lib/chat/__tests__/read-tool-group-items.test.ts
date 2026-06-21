import { describe, expect, it } from 'vitest';
import { ReadToolUseMessage } from '$shared/chat-types';
import { buildReadToolGroupRenderItems, summarizeReadToolGroup } from '../read-tool-group-items';

const TS = '2026-05-29T00:00:00.000Z';

describe('buildReadToolGroupRenderItems', () => {
	it('keeps duplicate tool IDs from producing duplicate Svelte keys', () => {
		const messages = [
			new ReadToolUseMessage(TS, 'duplicate-tool', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'duplicate-tool', '/tmp/b.ts'),
		];

		const items = buildReadToolGroupRenderItems(messages);

		expect(items.map((item) => item.key)).toEqual(['duplicate-tool', 'duplicate-tool#1']);
		expect(items.map((item) => item.displayName)).toEqual(['a.ts', 'b.ts']);
	});

	it('keeps existing keys stable when reads append to the group', () => {
		const first = [
			new ReadToolUseMessage(TS, 'duplicate-tool', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'duplicate-tool', ''),
		];
		const second = [...first, new ReadToolUseMessage(TS, 'duplicate-tool', '/tmp/c.ts')];

		const firstKeys = buildReadToolGroupRenderItems(first).map((item) => item.key);
		const secondKeys = buildReadToolGroupRenderItems(second).map((item) => item.key);

		expect(secondKeys.slice(0, firstKeys.length)).toEqual(firstKeys);
		expect(secondKeys[2]).toBe('duplicate-tool#2');
	});

	it('marks empty and whitespace paths as unknown', () => {
		const messages = [
			new ReadToolUseMessage(TS, 'read-1', ''),
			new ReadToolUseMessage(TS, 'read-2', '   '),
		];

		const items = buildReadToolGroupRenderItems(messages);

		expect(items.every((item) => item.isUnknown)).toBe(true);
		expect(items.map((item) => item.displayName)).toEqual(['Unknown file', 'Unknown file']);
	});

	it('preserves read range labels', () => {
		const messages = [new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts', 10, 5)];

		const items = buildReadToolGroupRenderItems(messages);

		expect(items[0].rangeLabel).toBe('Lines 10-14');
	});
});

describe('summarizeReadToolGroup', () => {
	it('summarizes groups where all file paths are known', () => {
		const summary = summarizeReadToolGroup([
			new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'read-2', '/tmp/b.ts'),
			new ReadToolUseMessage(TS, 'read-3', '/tmp/c.ts'),
		]);

		expect(summary).toEqual({
			totalCount: 3,
			unknownCount: 0,
			label: '3 files',
		});
	});

	it('summarizes groups with known and unknown file paths', () => {
		const summary = summarizeReadToolGroup([
			new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'read-2', ''),
			new ReadToolUseMessage(TS, 'read-3', '   '),
			new ReadToolUseMessage(TS, 'read-4', '/tmp/d.ts'),
			new ReadToolUseMessage(TS, 'read-5', '/tmp/e.ts'),
		]);

		expect(summary).toEqual({
			totalCount: 5,
			unknownCount: 2,
			label: '5 files (2 unknown)',
		});
	});

	it('summarizes groups where all file paths are unknown', () => {
		const summary = summarizeReadToolGroup([
			new ReadToolUseMessage(TS, 'read-1', ''),
			new ReadToolUseMessage(TS, 'read-2', '   '),
			new ReadToolUseMessage(TS, 'read-3', ''),
			new ReadToolUseMessage(TS, 'read-4', ''),
			new ReadToolUseMessage(TS, 'read-5', ''),
		]);

		expect(summary).toEqual({
			totalCount: 5,
			unknownCount: 5,
			label: '5 unknown files',
		});
	});
});
