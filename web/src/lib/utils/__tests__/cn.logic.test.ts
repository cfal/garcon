import { describe, expect, it } from 'vitest';
import { cn } from '../cn.js';

describe('cn', () => {
	it('lets callers override theme-role utilities', () => {
		expect(cn('rounded-(--control-radius)', 'rounded-none')).toBe('rounded-none');
		expect(cn('shadow-(--menu-shadow)', 'shadow-none')).toBe('shadow-none');
		expect(cn('bg-(color:--dialog-surface)', 'bg-background')).toBe('bg-background');
		expect(cn('p-(--menu-padding)', 'p-0')).toBe('p-0');
	});
});
