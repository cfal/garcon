import { describe, expect, it } from 'vitest';
import { buildThinkingOptions } from '$lib/chat/composer/composer-controls.js';

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

	it('marks Ultra as rainbow only for GPT-5.6 Sol', () => {
		const solUltra = buildThinkingOptions('codex', 'gpt-5.6-sol').find(
			(option) => option.value === 'ultra',
		);
		const terraUltra = buildThinkingOptions('codex', 'gpt-5.6-terra').find(
			(option) => option.value === 'ultra',
		);

		expect(solUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(terraUltra).not.toHaveProperty('rainbow');
	});

	it('recognizes GPT-5.6 Sol through an API endpoint model value', () => {
		const endpointSolUltra = buildThinkingOptions('codex', 'acme-openai:gpt-5.6-sol').find(
			(option) => option.value === 'ultra',
		);

		expect(endpointSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
	});

	it('keeps Ultra out of other agents', () => {
		expect(buildThinkingOptions('claude').some((option) => option.value === 'ultra')).toBe(false);
	});

	it('offers the current global interactive efforts to every Direct agent', () => {
		for (const agentId of [
			'direct-openai-compatible',
			'direct-openai-responses-compatible',
			'direct-anthropic-compatible',
		]) {
			expect(buildThinkingOptions(agentId).map((option) => option.value)).toEqual([
				'none',
				'low',
				'medium',
				'high',
				'xhigh',
				'max',
			]);
		}
	});
});
