import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import { transcriptDisplayRows } from '../transcript-row-projection';
import type { OptimisticUserInput } from '../optimistic-user-input';

describe('optimistic steer status', () => {
	it.each([true, false])('shows waiting only while queued (%s)', queued => {
		const input: OptimisticUserInput = { chatId: 'chat', clientMessageId: 'input', content: 'Synthetic guidance',
			createdAt: '2026-01-01T00:00:00Z', placement: 'live-tail',
			delivery: queued ? { kind: 'queued', clientMessageId: 'input', serverInstanceId: 'server', entryId: 'entry' } : 'delivered' };
		const [row] = transcriptDisplayRows({ entries: [], transcriptViewId: 'view', optimisticInputs: [input],
			optimisticAfterOrdinals: new Map(), notices: [] });
		expect(row).toMatchObject({ id: 'optimistic:input' });
		if (!queued) expect(row).not.toHaveProperty('inputStatus');
		else expect(row).toHaveProperty('inputStatus', 'waiting-to-steer');
	});
});

describe('durable transcript row reuse', () => {
	it('reuses immutable entries only within the same transcript view', () => {
		const entry = { ordinal: 1, message: new AssistantMessage('2026-01-01T00:00:00Z', 'Synthetic') };
		const input = { entries: [entry], transcriptViewId: 'first-view', optimisticInputs: [],
			optimisticAfterOrdinals: new Map<string, number>(), notices: [] };
		const first = transcriptDisplayRows(input);
		expect(transcriptDisplayRows(input)[0]).toBe(first[0]);
		const replacement = transcriptDisplayRows({ ...input, transcriptViewId: 'replacement-view' });
		expect(replacement[0]).not.toBe(first[0]);
		expect(replacement[0]).toMatchObject({ id: 'replacement-view:1', message: entry.message });
		expect(first[0]).toMatchObject({ id: 'first-view:1', message: entry.message });
		expect(transcriptDisplayRows(input)[0]).toMatchObject({ id: 'first-view:1' });
	});
});
