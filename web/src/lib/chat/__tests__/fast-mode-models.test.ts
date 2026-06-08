import { describe, expect, it } from 'vitest';
import { fastModeModelValue } from '../fast-mode-models';
import type { ModelOption } from '$lib/stores/model-catalog.svelte';

const models: ModelOption[] = [
	{ value: 'gpt-5.4', label: 'GPT-5.4' },
	{ value: 'gpt-5.4-fast', label: 'GPT-5.4 Fast Mode' },
	{ value: 'endpoint:gpt-5.5', label: 'Endpoint: GPT-5.5' },
	{ value: 'endpoint:gpt-5.5-speed', label: 'Endpoint: GPT-5.5 Fast Mode' },
	{ value: 'opus', label: 'Opus' },
];

describe('fastModeModelValue', () => {
	it('uses an exact fast model value when available', () => {
		expect(fastModeModelValue(models, 'gpt-5.4')).toBe('gpt-5.4-fast');
	});

	it('falls back to a matching fast-mode label when values do not share a suffix', () => {
		expect(fastModeModelValue(models, 'endpoint:gpt-5.5')).toBe('endpoint:gpt-5.5-speed');
	});

	it('keeps an already-fast model unchanged', () => {
		expect(fastModeModelValue(models, 'gpt-5.4-fast')).toBe('gpt-5.4-fast');
	});

	it('keeps the selected model when no fast variant exists', () => {
		expect(fastModeModelValue(models, 'opus')).toBe('opus');
	});
});
