import { describe, expect, it } from 'vitest';
import { THINKING_MODE_VALUES } from '$shared/chat-modes';
import { buildThinkingModeOptions } from '../thinking-mode-options';

describe('buildThinkingModeOptions', () => {
	it('presents every canonical effort in global order', () => {
		const options = buildThinkingModeOptions();

		expect(options.map((option) => option.id)).toEqual(THINKING_MODE_VALUES);
		expect(options[0]).toMatchObject({ id: 'none', label: 'Default' });
		for (const option of options) {
			expect(option.label).not.toBe('');
			expect(option.description).not.toBe('');
		}
	});
});
