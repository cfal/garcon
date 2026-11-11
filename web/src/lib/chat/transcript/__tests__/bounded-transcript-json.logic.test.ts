import { describe, expect, it } from 'vitest';
import { serializeTranscriptWithinBudget } from '../bounded-transcript-json';

const limits = { characters: 10_000, values: 100, depth: 8 };

describe('serializeTranscriptWithinBudget', () => {
	it('preserves complete JSON when all traversal budgets permit it', () => {
		const value = { rows: [{ ordinal: 1, text: 'Synthetic\n"output"' }], cursor: null };
		expect(serializeTranscriptWithinBudget(value, limits)).toBe(JSON.stringify(value));
	});

	it('checks the exact escaped size after the conservative traversal estimate', () => {
		const text = '\u0000'.repeat(20);
		const exactLength = JSON.stringify(text).length;
		expect(serializeTranscriptWithinBudget(text, { ...limits, characters: exactLength })).toBe(
			JSON.stringify(text),
		);
		expect(
			serializeTranscriptWithinBudget(text, { ...limits, characters: exactLength - 1 }),
		).toBeNull();
	});

	it('enforces the value boundary and rejects oversized arrays before reading elements', () => {
		const oversized = Array.from({ length: 3 }, () => 'synthetic');
		Object.defineProperty(oversized, 0, {
			get: () => {
				throw new Error('Array must be rejected before traversal');
			},
		});
		expect(serializeTranscriptWithinBudget(oversized, { ...limits, values: 3 })).toBeNull();
		const exact = { first: 'synthetic', second: 'synthetic' };
		expect(serializeTranscriptWithinBudget(exact, { ...limits, values: 3 })).toBe(
			JSON.stringify(exact),
		);
		expect(serializeTranscriptWithinBudget(exact, { ...limits, values: 2 })).toBeNull();
	});

	it('admits the depth boundary and rejects deeper or cyclic structures', () => {
		const nested = { child: { text: 'synthetic' } };
		expect(serializeTranscriptWithinBudget(nested, { ...limits, depth: 2 })).toBe(
			JSON.stringify(nested),
		);
		expect(serializeTranscriptWithinBudget(nested, { ...limits, depth: 1 })).toBeNull();
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(serializeTranscriptWithinBudget(cycle, limits)).toBeNull();
	});

	it('does not invoke custom serializers that could bypass the traversal budgets', () => {
		const value = {
			toJSON: () => {
				throw new Error('Custom serializer must not run');
			},
		};
		expect(serializeTranscriptWithinBudget(value, limits)).toBeNull();
	});

	it('rejects excessive property names before reading their values', () => {
		const value = Object.defineProperty({}, 'x'.repeat(200), {
			enumerable: true,
			get: () => {
				throw new Error('Oversized property must not be read');
			},
		});
		expect(serializeTranscriptWithinBudget(value, { ...limits, characters: 100 })).toBeNull();
	});
});
