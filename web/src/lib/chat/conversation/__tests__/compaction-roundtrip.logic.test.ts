import { describe, it, expect } from 'vitest';
import { CompactionMessage, parseChatMessage } from '$shared/chat-types';

const TS = '2026-03-01T00:00:00.000Z';

describe('CompactionMessage serialization round-trip', () => {
	it('preserves trigger, summary, and token counts', () => {
		const msg = new CompactionMessage(TS, 'manual', 'Summary body', 29611, 3903);
		const parsed = parseChatMessage(JSON.parse(JSON.stringify(msg)));
		expect(parsed).toBeInstanceOf(CompactionMessage);
		const compaction = parsed as CompactionMessage;
		expect(compaction.type).toBe('compaction');
		expect(compaction.trigger).toBe('manual');
		expect(compaction.summary).toBe('Summary body');
		expect(compaction.preTokens).toBe(29611);
		expect(compaction.postTokens).toBe(3903);
	});

	it('defaults an unknown trigger to manual and omits absent token counts', () => {
		const parsed = parseChatMessage({
			type: 'compaction',
			timestamp: TS,
			trigger: 'something-else',
			summary: 'only summary',
		}) as CompactionMessage;
		expect(parsed.trigger).toBe('manual');
		expect(parsed.preTokens).toBeUndefined();
		expect(parsed.postTokens).toBeUndefined();
	});

	it('round-trips an auto-triggered compaction', () => {
		const msg = new CompactionMessage(TS, 'auto', 'auto summary');
		const parsed = parseChatMessage(JSON.parse(JSON.stringify(msg))) as CompactionMessage;
		expect(parsed.trigger).toBe('auto');
		expect(parsed.summary).toBe('auto summary');
	});
});
