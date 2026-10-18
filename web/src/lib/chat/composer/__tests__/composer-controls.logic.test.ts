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

	it('marks Ultra as rainbow for GPT-6 Sol and GPT-5.6 Sol', () => {
		const solUltra = buildThinkingOptions(allModes, 'gpt-6-sol').find(
			(option) => option.value === 'ultra',
		);
		const latestSolUltra = buildThinkingOptions(allModes, 'gpt-6.1-sol').find(
			(option) => option.value === 'ultra',
		);
		const previousSolUltra = buildThinkingOptions(allModes, 'gpt-5.6-sol').find(
			(option) => option.value === 'ultra',
		);
		const terraUltra = buildThinkingOptions(allModes, 'gpt-5.6-terra').find(
			(option) => option.value === 'ultra',
		);

		expect(solUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(latestSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(previousSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(terraUltra).not.toHaveProperty('rainbow');
	});

	it('keeps higher-effort icons distinct from their tinted fills', () => {
		const options = buildThinkingOptions(['xhigh', 'max', 'ultra']);
		for (const [index, option] of options.entries()) {
			const classes = option.toneClass.split(' ');
			expect(classes).toContain('text-foreground');
			expect(classes).not.toContain('text-destructive');
			expect(classes).toContain(`bg-destructive/${20 + index * 10}`);
			expect(classes).toContain(`hover:bg-destructive/${30 + index * 10}`);
		}
	});

	it('recognizes GPT-6 Sol through an API endpoint model value', () => {
		const endpointSolUltra = buildThinkingOptions(allModes, 'acme-openai:gpt-6-sol').find(
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
