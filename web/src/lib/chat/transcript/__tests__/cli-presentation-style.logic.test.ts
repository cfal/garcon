import { describe, expect, it } from 'vitest';
import {
	cliPresentationLabel,
	cliPresentationSurfaceClass,
} from '../cli-presentation-style';
import { chatEventCardSurfaceClass } from '../chat-event-card-style';

describe('CLI presentation styles', () => {
	it('maps every style to a distinct label and semantic treatment', () => {
		expect(cliPresentationLabel('info')).toBe('CLI info');
		expect(cliPresentationSurfaceClass('info')).toBe(chatEventCardSurfaceClass('neutral'));

		expect(cliPresentationLabel('notice')).toBe('CLI notice');
		expect(cliPresentationSurfaceClass('notice')).toBe(chatEventCardSurfaceClass('info'));

		expect(cliPresentationLabel('error')).toBe('CLI error');
		expect(cliPresentationSurfaceClass('error')).toBe(chatEventCardSurfaceClass('error'));

		expect(cliPresentationLabel('custom')).toBe('CLI custom');
		expect(cliPresentationSurfaceClass('custom')).toBe('cli-presentation-custom');
	});
});
