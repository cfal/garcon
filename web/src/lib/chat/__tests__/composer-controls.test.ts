import { describe, expect, it } from 'vitest';
import { buildThinkingOptions } from '$lib/chat/composer-controls';

describe('buildThinkingOptions', () => {
	it('includes Ultra for Codex', () => {
		expect(buildThinkingOptions('codex').map((option) => option.label)).toEqual([
			'Default',
			'Low',
			'Medium',
			'High',
			'X-High',
			'Max',
			'Ultra',
		]);
	});

	it('keeps Ultra out of other agents', () => {
		expect(buildThinkingOptions('claude').some((option) => option.value === 'ultra')).toBe(false);
	});
});
