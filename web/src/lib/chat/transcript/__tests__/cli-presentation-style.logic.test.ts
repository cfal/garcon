import { describe, expect, it } from 'vitest';
import {
	cliPresentationCardVariant,
	cliPresentationHeaderClass,
	cliPresentationLabel,
} from '../cli-presentation-style';

describe('CLI presentation styles', () => {
	it('maps every style to a distinct label and semantic treatment', () => {
		expect(cliPresentationLabel('info')).toBe('CLI info');
		expect(cliPresentationCardVariant('info')).toBe('neutral');
		expect(cliPresentationHeaderClass('info')).toContain('status-neutral');

		expect(cliPresentationLabel('notice')).toBe('CLI notice');
		expect(cliPresentationCardVariant('notice')).toBe('info');
		expect(cliPresentationHeaderClass('notice')).toContain('status-info');

		expect(cliPresentationLabel('error')).toBe('CLI error');
		expect(cliPresentationCardVariant('error')).toBe('error');
		expect(cliPresentationHeaderClass('error')).toContain('status-error');
	});
});
