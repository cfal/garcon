import { describe, expect, it } from 'vitest';
import { formatCompactProjectPath } from '../compact-project-path';

describe('formatCompactProjectPath', () => {
	it('keeps paths that fit within the display limit', () => {
		expect(formatCompactProjectPath('/workspace/project-a')).toBe('/workspace/project-a');
	});

	it('keeps the longest complete suffix that fits when a path is too long', () => {
		expect(formatCompactProjectPath('/workspace/clients/acme/products/garcon/project-a')).toBe(
			'\u2026/acme/products/garcon/project-a',
		);
	});
});
