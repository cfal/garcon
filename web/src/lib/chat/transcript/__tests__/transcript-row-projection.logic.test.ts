import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import { transcriptDisplayRows } from '../transcript-row-projection';

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
