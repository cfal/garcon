import { describe, expect, it } from 'vitest';
import { buildThinkingOptions } from '$lib/chat/composer/composer-controls.js';

describe('buildThinkingOptions', () => {
	const allModes = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

	it('includes every mode declared by the integration catalog', () => {
		expect(buildThinkingOptions(allModes).map((option) => option.label)).toEqual([
			'Default',
			'Low',
			'Medium',
			'High',
			'X-High',
			'Max',
			'Ultra',
		]);
	});

	it('marks Ultra as rainbow only for GPT-5.6 Sol', () => {
		const solUltra = buildThinkingOptions(allModes, 'gpt-5.6-sol').find(
			(option) => option.value === 'ultra',
		);
		const terraUltra = buildThinkingOptions(allModes, 'gpt-5.6-terra').find(
			(option) => option.value === 'ultra',
		);

		expect(solUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(terraUltra).not.toHaveProperty('rainbow');
	});

	it('recognizes GPT-5.6 Sol through an API endpoint model value', () => {
		const endpointSolUltra = buildThinkingOptions(allModes, 'acme-openai:gpt-5.6-sol').find(
			(option) => option.value === 'ultra',
		);

		expect(endpointSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
	});

	it('keeps undeclared modes out of the options', () => {
		expect(buildThinkingOptions(['none', 'high']).map((option) => option.value)).toEqual([
			'none',
			'high',
		]);
	});

	it('preserves the catalog order', () => {
		expect(buildThinkingOptions(['max', 'none', 'medium']).map((option) => option.value)).toEqual([
			'max',
			'none',
			'medium',
		]);
	});
});
