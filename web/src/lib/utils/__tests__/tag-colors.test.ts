import { describe, expect, it } from 'vitest';

import { getTagColorVariant, getTagColorClasses, type TagColorVariant } from '../tag-colors';

const VALID_VARIANTS: TagColorVariant[] = ['blue', 'green', 'amber', 'purple', 'rose', 'teal', 'indigo', 'orange'];

describe('getTagColorVariant', () => {
	it('returns the same variant for the same tag (deterministic)', () => {
		const first = getTagColorVariant('ops');
		const second = getTagColorVariant('ops');
		expect(first).toBe(second);
	});

	it('can return different variants for different tags', () => {
		const variants = new Set(['ops', 'bugs', 'deploy', 'infra', 'test', 'ci', 'docs', 'perf'].map(getTagColorVariant));
		expect(variants.size).toBeGreaterThan(1);
	});

	it('returns a valid variant from the enum', () => {
		expect(VALID_VARIANTS).toContain(getTagColorVariant('ops'));
		expect(VALID_VARIANTS).toContain(getTagColorVariant('anything'));
	});
});

describe('getTagColorClasses', () => {
	it('returns a non-empty CSS class string', () => {
		const classes = getTagColorClasses('ops');
		expect(classes.length).toBeGreaterThan(0);
		expect(classes).toContain('bg-');
		expect(classes).toContain('text-');
	});
});
