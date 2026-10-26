import { describe, expect, it } from 'vitest';
import {
	fontSizeLabel,
	typographyDefaultSizeLabel,
	typographySizeLabel,
} from '../typography-labels.js';

describe('typography size labels', () => {
	it.each([
		['interface', '14', '14px base'],
		['chat-list', '14', '14px base'],
		['chat-feed', '14', '14px'],
		['chat-code', '11/12', '11/12px'],
		['chat-output', '14', '14px'],
		['code-editor', '12', '12px'],
		['expanded-editor', '14', '14px'],
		['code-diff', '11-13', '11-13px'],
		['terminal', '13', '13px'],
	] as const)(
		'shares the %s default between dialog and summary labels',
		(surface, value, label) => {
			expect(typographyDefaultSizeLabel(surface)).toBe(value);
			expect(typographySizeLabel(surface, 'default')).toBe(label);
			expect(fontSizeLabel('default', surface)).toBe(`${label} (Default)`);
			const explicit = surface === 'interface' || surface === 'chat-list' ? '18px base' : '18px';
			expect(typographySizeLabel(surface, '18')).toBe(explicit);
			expect(fontSizeLabel('18', surface)).toBe(explicit);
		},
	);
});
