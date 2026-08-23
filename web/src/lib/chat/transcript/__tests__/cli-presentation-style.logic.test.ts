import { describe, expect, it } from 'vitest';
import {
	cliPresentationCardVariant,
	cliPresentationHeaderClass,
	cliPresentationLabel,
} from '../cli-presentation-style';

describe('CLI presentation styles', () => {
	it('maps notice and error to distinct labels and semantic tokens', () => {
		expect(cliPresentationLabel('notice')).toBe('CLI notice');
		expect(cliPresentationCardVariant('notice')).toBe('info');
		expect(cliPresentationHeaderClass('notice')).toContain('status-info');

		expect(cliPresentationLabel('error')).toBe('CLI error');
		expect(cliPresentationCardVariant('error')).toBe('error');
		expect(cliPresentationHeaderClass('error')).toContain('status-error');
	});
});
