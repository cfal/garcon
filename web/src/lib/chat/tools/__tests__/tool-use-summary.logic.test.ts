import { describe, expect, it } from 'vitest';
import { summarizeToolCounts } from '../tool-use-summary.js';

describe('summarizeToolCounts', () => {
	it('formats certified totals in their first-occurrence order', () => {
		const summary = summarizeToolCounts(14,
			{ commands: 5, fileReads: 3, fileEdits: 5, other: 1 },
			['fileReads', 'fileEdits', 'commands', 'other']);
		expect(summary).toEqual({ count: 14, label: 'Read 3 files, edit 5 files, execute 5 commands, an action' });
	});

	it('combines singular and plural action categories', () => {
		const summary = summarizeToolCounts(4,
			{ commands: 1, fileReads: 1, fileEdits: 2, other: 0 },
			['fileReads', 'fileEdits', 'commands']);
		expect(summary.label).toBe('Read a file, edit 2 files, execute a command');
	});

	it('formats generic actions without tool names or payloads', () => {
		const summary = summarizeToolCounts(3,
			{ commands: 0, fileReads: 0, fileEdits: 0, other: 3 }, ['other']);
		expect(summary.label).toBe('3 actions');
	});

	it('formats command totals', () => {
		const summary = summarizeToolCounts(3,
			{ commands: 3, fileReads: 0, fileEdits: 0, other: 0 }, ['commands']);
		expect(summary.label).toBe('Execute 3 commands');
	});

	it('keeps invocation count separate from weighted file totals', () => {
		const summary = summarizeToolCounts(1,
			{ commands: 0, fileReads: 0, fileEdits: 3, other: 0 }, ['fileEdits']);
		expect(summary).toEqual({ count: 1, label: 'Edit 3 files' });
	});

	it('uses singular grammar and omits zero-count clauses', () => {
		const summary = summarizeToolCounts(1,
			{ commands: 0, fileReads: 1, fileEdits: 0, other: 0 }, ['commands', 'fileReads', 'other']);
		expect(summary.label).toBe('Read a file');
	});
});
