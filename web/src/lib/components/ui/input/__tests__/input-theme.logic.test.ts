import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Input theme treatment', () => {
	it('retains semantic selection painting on both input branches', () => {
		const source = readFileSync(new URL('../input.svelte', import.meta.url), 'utf8');

		expect(source.match(/selection:bg-primary/g)).toHaveLength(2);
		expect(source.match(/selection:text-primary-foreground/g)).toHaveLength(2);
	});
});
